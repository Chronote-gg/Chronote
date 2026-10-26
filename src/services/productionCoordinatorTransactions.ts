import { isDeepStrictEqual } from "node:util";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  controlRecordSchema,
  type ControlRecord,
  type PromotionInput,
  type RuntimeRetirementRequestInput,
} from "../types/deploymentControl";
import { type IntroductionHold } from "../types/productionIntroduction";
import {
  effectiveHandoff,
  introductionChecks,
  type IntroductionAuthority,
} from "./productionIntroductionTransactions";
import {
  buildPromotionTransaction,
  buildRuntimeRetirementRequest,
} from "./deploymentControlTransactions";
import type { TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
type Scope = {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  table: string;
  meetingHistory: string;
};
function assertControl(scope: Scope, previous: ControlRecord) {
  controlRecordSchema.parse(previous);
  const { hold, authority } = scope;
  if (
    !isDeepStrictEqual(previous.maintenance, {
      holdId: hold.holdId,
      introductionId: hold.introductionId,
      revision: hold.revision,
    }) ||
    ![
      authority.handoff.priorRunToken,
      authority.failedUnserved?.runToken,
      authority.handoff.runToken,
    ].includes(previous.coordinatorToken)
  )
    throw new Error("introduction_refused");
}
export function buildCoordinatorControlSave(
  scope: Scope,
  previous: ControlRecord,
  next: ControlRecord,
): TransactWriteItemsCommandInput {
  assertControl(scope, previous);
  controlRecordSchema.parse(next);
  const h = effectiveHandoff(scope.authority, next.coordinatorEpoch - 1);
  if (
    next.coordinatorToken !== scope.authority.handoff.runToken ||
    next.coordinatorEpoch !== h.priorEpoch + 1 ||
    !isDeepStrictEqual(previous.servingMembers, next.servingMembers) ||
    previous.servingGeneration !== next.servingGeneration ||
    !isDeepStrictEqual(previous.maintenance, next.maintenance) ||
    next.deployment?.candidateId !== scope.authority.handoff.candidateId ||
    next.deployment.image.split("@")[1] !== scope.authority.handoff.imageDigest
  )
    throw new Error("introduction_refused");
  const fields = [
    "coordinatorToken",
    "coordinatorEpoch",
    "coordinatorExpiresAt",
    "deployment",
  ] as const;
  const compare = [
    "coordinatorToken",
    "coordinatorEpoch",
    "coordinatorExpiresAt",
    "servingGeneration",
    "servingMembers",
    "maintenance",
  ] as const;
  const names: Record<string, string> = {},
    values: Record<string, unknown> = {};
  const condition = compare.map((field, i) => {
    names[`#p${i}`] = field;
    values[`:p${i}`] = previous[field];
    return `#p${i} = :p${i}`;
  });
  names["#oldDeployment"] = "deployment";
  if (previous.deployment) {
    values[":oldDeployment"] = previous.deployment;
    condition.push("#oldDeployment = :oldDeployment");
  } else condition.push("attribute_not_exists(#oldDeployment)");
  const set = fields.map((field, i) => {
    names[`#n${i}`] = field;
    values[`:n${i}`] = next[field];
    return `#n${i} = :n${i}`;
  });
  return {
    TransactItems: [
      {
        Update: {
          TableName: scope.table,
          Key: marshall({ pk: "ENV", sk: "CONTROL" }),
          UpdateExpression: `SET ${set.join(", ")}`,
          ConditionExpression: condition.join(" AND "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(values),
        },
      },
      ...introductionChecks(scope.hold, scope.authority, scope.table),
    ],
  };
}
function guard(scope: Scope, transaction: TransactWriteItemsCommandInput) {
  const item = transaction.TransactItems?.find(
    (item) => (item.Update ?? item.ConditionCheck)?.Key?.sk?.S === "CONTROL",
  );
  const control = item?.Update ?? item?.ConditionCheck;
  if (control) {
    control.ConditionExpression += " AND maintenance = :maintenance";
    Object.assign(
      control.ExpressionAttributeValues!,
      marshall({
        ":maintenance": {
          holdId: scope.hold.holdId,
          introductionId: scope.hold.introductionId,
          revision: scope.hold.revision,
        },
      }),
    );
  }
  transaction.TransactItems!.push(
    ...introductionChecks(scope.hold, scope.authority, scope.table),
  );
  return transaction;
}
export function buildCoordinatorPromotion(scope: Scope, input: PromotionInput) {
  const h = effectiveHandoff(scope.authority, input.coordinatorEpoch - 1);
  if (
    input.coordinatorToken !== h.runToken ||
    input.coordinatorEpoch !== h.priorEpoch + 1 ||
    input.expectedServingGeneration !== 1 ||
    input.proposedGeneration !== 2 ||
    input.candidate.kind !== "ecs" ||
    input.candidate.candidateId !== h.candidateId ||
    input.candidate.imageDigest !== h.imageDigest
  )
    throw new Error("introduction_refused");
  return guard(
    scope,
    buildPromotionTransaction({
      ...input,
      tables: {
        deploymentControl: scope.table,
        meetingHistory: scope.meetingHistory,
      },
    }),
  );
}
export function buildCoordinatorRetirement(
  scope: Scope,
  input: RuntimeRetirementRequestInput,
) {
  const h = effectiveHandoff(
    scope.authority,
    input.request.coordinatorEpoch - 1,
  );
  if (
    input.request.coordinatorToken !== h.runToken ||
    input.request.coordinatorEpoch !== h.priorEpoch + 1 ||
    input.request.authorizedGeneration !== 1 ||
    input.record.identity.kind !== "ecs" ||
    input.record.identity.candidateId !== h.priorCandidateId ||
    input.record.identity.imageDigest !== h.priorDigest
  )
    throw new Error("introduction_refused");
  return guard(
    scope,
    buildRuntimeRetirementRequest(input, {
      deploymentControl: scope.table,
      meetingHistory: scope.meetingHistory,
    }),
  );
}
