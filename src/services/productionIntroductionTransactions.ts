import { z } from "zod";
import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  TransactWriteItem,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  introductionHoldSchema,
  type IntroductionHold,
} from "../types/productionIntroduction";
const id = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().int().nonnegative();
export const introductionActionKindSchema = z.enum([
  "stop_legacy",
  "stop_service",
  "coordinator_write",
  "introduction_write",
  "acceptance_write",
  "stop_failed",
  "route_maintenance",
  "route_candidate",
  "launch_candidate",
  "hold_launcher",
  "restore_launcher",
]);
const common = {
  holdId: id,
  introductionId: id,
  manifestHash: hash,
  operationId: id,
  revision: z.number().int().positive(),
  actor: id,
  runToken: id,
};
const handoffSchema = z
  .object({
    runToken: id,
    priorRunToken: id,
    priorEpoch: z.number().int().positive(),
    priorGeneration: z.literal(1),
    priorCandidateId: id,
    priorDigest: id,
    candidateId: id,
    taskDefinition: id,
    imageDigest: id,
  })
  .strict();
export const introductionAuthoritySchema = z
  .object({
    ...common,
    pk: id,
    sk: id,
    recordType: z.literal("introduction_authority"),
    validFrom: seconds,
    validUntil: seconds,
    handoff: handoffSchema,
    failedUnserved: z
      .object({
        candidateId: id,
        taskDefinition: id,
        imageDigest: id,
        runToken: id,
        expectedEpoch: z.literal(1),
        epoch: z.literal(2),
      })
      .strict()
      .optional(),
    actions: z.record(
      id,
      z
        .object({ kind: introductionActionKindSchema, intentHash: hash })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (v) =>
      v.pk === `INTRODUCTION#${v.introductionId}` &&
      v.sk === `OPERATION#${v.operationId}` &&
      v.validUntil > v.validFrom &&
      Object.keys(v.actions).length > 0,
  );
export type IntroductionAuthority = z.infer<typeof introductionAuthoritySchema>;
import { introductionHistoricalFactsSchema } from "./productionIntroductionHistory";
const receipt = z
  .object({
    resourceIds: z.array(id).min(1).max(100),
    evidenceHash: hash,
    facts: introductionHistoricalFactsSchema.optional(),
  })
  .strict();
const actionFields = {
  ...common,
  pk: id,
  sk: id,
  recordType: z.literal("introduction_action"),
  actionId: id,
  kind: introductionActionKindSchema,
  intentHash: hash,
  requestHash: hash,
  predecessor: z
    .object({ actionId: id, receiptHash: hash })
    .strict()
    .nullable(),
  reservedAt: seconds,
};
const submitted = { attemptId: z.uuid(), submittedAt: seconds };
export const introductionActionSchema = z
  .discriminatedUnion("phase", [
    z
      .object({
        ...actionFields,
        phase: z.literal("reserved"),
        version: z.literal(1),
      })
      .strict(),
    z
      .object({
        ...actionFields,
        ...submitted,
        phase: z.literal("submitted"),
        version: z.literal(2),
      })
      .strict(),
    z
      .object({
        ...actionFields,
        ...submitted,
        acknowledgment: receipt,
        acknowledgedAt: seconds,
        acknowledgedAtMilliseconds: seconds.optional(),
        phase: z.literal("acknowledged"),
        version: z.literal(3),
      })
      .strict(),
    z
      .object({
        ...actionFields,
        ...submitted,
        acknowledgment: receipt,
        acknowledgedAt: seconds,
        acknowledgedAtMilliseconds: seconds.optional(),
        observation: receipt,
        observedAt: seconds,
        phase: z.literal("observed"),
        version: z.literal(4),
      })
      .strict(),
  ])
  .refine(
    (v) =>
      v.pk === `INTRODUCTION#${v.introductionId}` &&
      v.sk === `ACTION#${v.actionId}`,
  );
export type IntroductionAction = z.infer<typeof introductionActionSchema>;
type Tables = { deploymentControl: string };
function absentPut(table: string, item: object): TransactWriteItem {
  return {
    Put: {
      TableName: table,
      Item: marshall(item),
      ConditionExpression: "attribute_not_exists(pk)",
    },
  };
}
function exactCheck(
  table: string,
  row: Record<string, unknown>,
): NonNullable<TransactWriteItem["ConditionCheck"]> {
  const entries = Object.entries(row).filter(
    ([key]) => key !== "pk" && key !== "sk",
  );
  return {
    TableName: table,
    Key: marshall({ pk: row.pk, sk: row.sk }),
    ConditionExpression: entries.map((_, i) => `#f${i} = :v${i}`).join(" AND "),
    ExpressionAttributeNames: Object.fromEntries(
      entries.map(([key], i) => [`#f${i}`, key]),
    ),
    ExpressionAttributeValues: marshall(
      Object.fromEntries(entries.map(([, value], i) => [`:v${i}`, value])),
    ),
  };
}
function holdCheck(hold: IntroductionHold, table: string): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: marshall({ pk: "ENV", sk: "INTRODUCTION" }),
      ConditionExpression:
        "holdId = :hold AND introductionId = :intro AND manifestHash = :hash AND revision = :revision AND admission.#state = :held AND deployment.#state = :held",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: marshall({
        ":hold": hold.holdId,
        ":intro": hold.introductionId,
        ":hash": hold.manifestHash,
        ":revision": hold.revision,
        ":held": "held",
      }),
    },
  };
}
function validateAuthority(
  hold: IntroductionHold,
  authority: IntroductionAuthority,
) {
  introductionHoldSchema.parse(hold);
  introductionAuthoritySchema.parse(authority);
  if (
    hold.admission.state !== "held" ||
    hold.deployment.state !== "held" ||
    ["holdId", "introductionId", "manifestHash", "revision"].some(
      (key) => Reflect.get(hold, key) !== Reflect.get(authority, key),
    )
  )
    throw new Error("introduction_refused");
}
export function buildAcquireIntroductionHold({
  hold,
  authority,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  tables: Tables;
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  if (hold.revision !== 1 || hold.fixtureGrantIds?.length)
    throw new Error("introduction_refused");
  return {
    TransactItems: [
      absentPut(tables.deploymentControl, hold),
      absentPut(tables.deploymentControl, authority),
      {
        ConditionCheck: {
          TableName: tables.deploymentControl,
          Key: marshall({ pk: "ENV", sk: "CONTROL" }),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ],
  };
}
export function buildReserveIntroductionAction({
  hold,
  authority,
  action,
  now,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  action: IntroductionAction;
  now: number;
  tables: Tables;
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  introductionActionSchema.parse(action);
  const approved = authority.actions[action.actionId];
  if (
    action.phase !== "reserved" ||
    now < authority.validFrom ||
    now >= authority.validUntil ||
    !approved ||
    approved.kind !== action.kind ||
    approved.intentHash !== action.intentHash ||
    Object.keys(common).some(
      (key) => Reflect.get(action, key) !== Reflect.get(authority, key),
    )
  )
    throw new Error("introduction_refused");
  return {
    TransactItems: [
      holdCheck(hold, tables.deploymentControl),
      { ConditionCheck: exactCheck(tables.deploymentControl, authority) },
      absentPut(tables.deploymentControl, action),
      ...(action.predecessor
        ? [
            {
              ConditionCheck: {
                TableName: tables.deploymentControl,
                Key: marshall({
                  pk: action.pk,
                  sk: `ACTION#${action.predecessor.actionId}`,
                }),
                ConditionExpression:
                  "#phase = :observed AND observation.evidenceHash = :hash AND manifestHash = :manifest",
                ExpressionAttributeNames: { "#phase": "phase" },
                ExpressionAttributeValues: marshall({
                  ":observed": "observed",
                  ":hash": action.predecessor.receiptHash,
                  ":manifest": action.manifestHash,
                }),
              },
            },
          ]
        : []),
    ],
  };
}
export function buildTransitionIntroductionAction({
  hold,
  authority,
  previous,
  next,
  now,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  previous: IntroductionAction;
  next: IntroductionAction;
  now: number;
  tables: Tables;
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  introductionActionSchema.parse(previous);
  introductionActionSchema.parse(next);
  if (
    Object.keys(common).some(
      (key) => Reflect.get(previous, key) !== Reflect.get(authority, key),
    ) ||
    authority.actions[previous.actionId]?.kind !== previous.kind ||
    authority.actions[previous.actionId]?.intentHash !== previous.intentHash ||
    next.version !== previous.version + 1 ||
    Object.keys(previous)
      .filter((key) => !["phase", "version"].includes(key))
      .some(
        (key) =>
          JSON.stringify(Reflect.get(previous, key)) !==
          JSON.stringify(Reflect.get(next, key)),
      )
  )
    throw new Error("introduction_refused");
  if (
    next.phase === "submitted" &&
    (now < authority.validFrom || now >= authority.validUntil)
  )
    throw new Error("introduction_refused");
  const condition = exactCheck(tables.deploymentControl, previous);
  // No ClientRequestToken: a repeated submit must fail its state condition, not return idempotent success.
  return {
    TransactItems: [
      holdCheck(hold, tables.deploymentControl),
      { ConditionCheck: exactCheck(tables.deploymentControl, authority) },
      {
        Put: {
          TableName: condition.TableName,
          ConditionExpression: condition.ConditionExpression,
          ExpressionAttributeNames: condition.ExpressionAttributeNames,
          ExpressionAttributeValues: condition.ExpressionAttributeValues,
          Item: marshall(next),
        },
      },
    ],
  };
}
import { isDeepStrictEqual } from "node:util";
import {
  controlRecordSchema,
  runtimeIdentitySchema,
  type ControlRecord,
  type PromotionInput,
} from "../types/deploymentControl";
import { buildPromotionTransaction } from "./deploymentControlTransactions";
import {
  buildPausedInitializationItems,
  pausedInitializationDigestsSchema,
  type PausedInitializationGuards,
} from "./productionPausedInitialization";
export type { PausedInitializationGuards } from "./productionPausedInitialization";

export const fixtureCoordinatorAuthoritySchema = z
  .object({
    pk: id,
    sk: z.literal("FIXTURE_COORDINATOR"),
    recordType: z.literal("fixture_coordinator_authority"),
    holdId: id,
    introductionId: id,
    manifestHash: hash,
    revision: z.number().int().positive(),
    runToken: id,
    priorRunToken: id,
    priorEpoch: z.number().int().positive(),
    priorGeneration: z.literal(1),
    priorMember: runtimeIdentitySchema,
    candidateId: id,
    taskDefinition: id,
    imageDigest: id,
  })
  .strict()
  .refine(
    (v) =>
      v.pk === `INTRODUCTION#${v.introductionId}` &&
      v.runToken !== v.priorRunToken &&
      v.priorMember.kind === "ecs",
  );
export type FixtureCoordinatorAuthority = z.infer<
  typeof fixtureCoordinatorAuthoritySchema
>;
function pointer(hold: IntroductionHold) {
  return {
    holdId: hold.holdId,
    introductionId: hold.introductionId,
    revision: hold.revision,
  };
}
function assertInitialControl(
  control: ControlRecord,
  hold: IntroductionHold,
  authority: IntroductionAuthority,
) {
  controlRecordSchema.parse(control);
  if (
    control.runtimeEnvironment !== "ecs" ||
    control.servingGeneration !== 0 ||
    Object.keys(control.servingMembers).length ||
    control.deployment ||
    control.compatibleReplacement ||
    control.recoveryScanCursor ||
    control.coordinatorToken !== authority.runToken ||
    control.coordinatorEpoch !== 1 ||
    !isDeepStrictEqual(control.maintenance, pointer(hold))
  )
    throw new Error("introduction_refused");
}
function assertInitializationLineage(
  lineage: IntroductionAction[],
  hold: IntroductionHold,
  authority: IntroductionAuthority,
) {
  const stops = Object.entries(authority.actions)
    .filter(([, a]) => ["stop_legacy", "stop_service"].includes(a.kind))
    .map(([id]) => id);
  if (
    !stops.length ||
    !stops.every((id) => lineage.some((row) => row.actionId === id)) ||
    !lineage.some((row) => row.kind === "route_maintenance") ||
    new Set(lineage.map((row) => row.actionId)).size !== lineage.length
  )
    throw new Error("introduction_refused");
  for (const row of lineage) {
    introductionActionSchema.parse(row);
    if (
      row.phase !== "observed" ||
      ![
        "stop_legacy",
        "stop_service",
        "route_maintenance",
        "hold_launcher",
      ].includes(row.kind) ||
      row.manifestHash !== hold.manifestHash ||
      row.operationId !== authority.operationId ||
      row.intentHash !== authority.actions[row.actionId]?.intentHash
    )
      throw new Error("introduction_refused");
  }
}
export function buildInitializeIntroductionControl({
  hold,
  authority,
  control,
  lineage,
  tables,
  paused,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  control: ControlRecord;
  lineage: IntroductionAction[];
  tables: Tables & { personalJob?: string; personalSegment?: string };
  paused?: PausedInitializationGuards;
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  assertInitialControl(control, hold, authority);
  assertInitializationLineage(lineage, hold, authority);
  const pausedItems = paused
    ? buildPausedInitializationItems(paused, authority, tables)
    : [];
  return {
    TransactItems: [
      holdCheck(hold, tables.deploymentControl),
      { ConditionCheck: exactCheck(tables.deploymentControl, authority) },
      ...lineage.map((row) => ({
        ConditionCheck: exactCheck(tables.deploymentControl, row),
      })),
      absentPut(tables.deploymentControl, control),
      absentPut(tables.deploymentControl, {
        pk: `INTRODUCTION#${hold.introductionId}`,
        sk: "INITIALIZATION",
        recordType: "introduction_initialization",
        manifestHash: hold.manifestHash,
        holdId: hold.holdId,
        revision: hold.revision,
        coordinatorToken: control.coordinatorToken,
        coordinatorEpoch: control.coordinatorEpoch,
        actions: lineage.map((row) => ({
          actionId: row.actionId,
          requestHash: row.requestHash,
        })),
        ...(paused
          ? {
              paused: pausedInitializationDigestsSchema.parse({
                cohortSha256: paused.cohortSha256,
                captureSha256: paused.captureSha256,
                policyScopeSha256: paused.policyScopeSha256,
              }),
            }
          : {}),
      }),
      ...pausedItems,
    ],
  };
}
export function buildIntroductionPromotion({
  hold,
  authority,
  promotion,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  promotion: PromotionInput;
  tables: Parameters<typeof buildPromotionTransaction>[0]["tables"];
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  const bootstrap = bootstrapAuthority(authority, promotion.coordinatorEpoch);
  if (
    promotion.expectedServingGeneration !== 0 ||
    promotion.expectedServingMembers.length ||
    promotion.proposedGeneration !== 1 ||
    promotion.coordinatorToken !== bootstrap.runToken ||
    promotion.coordinatorEpoch !== bootstrap.epoch ||
    promotion.candidate.kind !== "ecs" ||
    promotion.candidate.candidateId !== bootstrap.candidateId ||
    promotion.candidate.imageDigest !== bootstrap.imageDigest
  )
    throw new Error("introduction_refused");
  const transaction = buildPromotionTransaction({ ...promotion, tables });
  const update = transaction.TransactItems?.[0].Update;
  if (!update) throw new Error("introduction_refused");
  update.UpdateExpression += ", coordinatorExpiresAt = :released";
  update.ConditionExpression += " AND maintenance = :maintenance";
  Object.assign(
    update.ExpressionAttributeValues!,
    marshall({ ":released": 0, ":maintenance": pointer(hold) }),
  );
  transaction.TransactItems!.push(holdCheck(hold, tables.deploymentControl), {
    ConditionCheck: exactCheck(tables.deploymentControl, authority),
  });
  return transaction;
}
export function buildAuthorizeFixtureCoordinator({
  hold,
  authority,
  expectedControl,
  operation,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  expectedControl: ControlRecord;
  operation: FixtureCoordinatorAuthority;
  tables: Tables;
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  controlRecordSchema.parse(expectedControl);
  fixtureCoordinatorAuthoritySchema.parse(operation);
  const h = effectiveHandoff(authority, expectedControl.coordinatorEpoch);
  if (
    expectedControl.coordinatorExpiresAt !== 0 ||
    expectedControl.deployment ||
    expectedControl.compatibleReplacement ||
    expectedControl.coordinatorToken !== h.priorRunToken ||
    expectedControl.coordinatorEpoch !== h.priorEpoch ||
    expectedControl.servingGeneration !== h.priorGeneration ||
    !isDeepStrictEqual(expectedControl.maintenance, pointer(hold)) ||
    Object.keys(expectedControl.servingMembers).length !== 1 ||
    !isDeepStrictEqual(
      Object.values(expectedControl.servingMembers)[0],
      operation.priorMember,
    ) ||
    operation.priorMember.kind !== "ecs" ||
    operation.priorMember.candidateId !== h.priorCandidateId ||
    operation.priorMember.imageDigest !== h.priorDigest ||
    [
      "runToken",
      "priorRunToken",
      "priorEpoch",
      "priorGeneration",
      "candidateId",
      "taskDefinition",
      "imageDigest",
    ].some((key) => Reflect.get(operation, key) !== Reflect.get(h, key)) ||
    ["holdId", "introductionId", "manifestHash", "revision"].some(
      (key) => Reflect.get(operation, key) !== Reflect.get(hold, key),
    )
  )
    throw new Error("introduction_refused");
  return {
    TransactItems: [
      holdCheck(hold, tables.deploymentControl),
      { ConditionCheck: exactCheck(tables.deploymentControl, authority) },
      { ConditionCheck: exactCheck(tables.deploymentControl, expectedControl) },
      absentPut(tables.deploymentControl, operation),
    ],
  };
}

export { introductionHoldSchema, controlRecordSchema };

export function introductionChecks(
  hold: IntroductionHold,
  authority: IntroductionAuthority,
  table: string,
): TransactWriteItem[] {
  validateAuthority(hold, authority);
  return [
    holdCheck(hold, table),
    { ConditionCheck: exactCheck(table, authority) },
  ];
}

export function bootstrapAuthority(
  authority: IntroductionAuthority,
  epoch: number,
) {
  if (epoch === authority.handoff.priorEpoch)
    return {
      runToken: authority.runToken,
      epoch,
      candidateId: authority.handoff.priorCandidateId,
      imageDigest: authority.handoff.priorDigest,
    };
  const replacement = authority.failedUnserved;
  if (!replacement || replacement.epoch !== epoch)
    throw new Error("introduction_refused");
  return replacement;
}
export function effectiveHandoff(
  authority: IntroductionAuthority,
  priorEpoch: number,
) {
  const prior = bootstrapAuthority(authority, priorEpoch);
  return {
    ...authority.handoff,
    priorRunToken: prior.runToken,
    priorEpoch: prior.epoch,
    priorCandidateId: prior.candidateId,
    priorDigest: prior.imageDigest,
  };
}
export function buildReplaceUnservedControl({
  hold,
  authority,
  previous,
  launch,
  now,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  previous: ControlRecord;
  launch: IntroductionAction;
  now: number;
  tables: Tables;
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  assertInitialControl(previous, hold, authority);
  introductionActionSchema.parse(launch);
  const replacement = authority.failedUnserved;
  if (
    !replacement ||
    previous.coordinatorExpiresAt > now ||
    previous.coordinatorEpoch !== replacement.expectedEpoch ||
    launch.kind !== "launch_candidate" ||
    launch.phase !== "observed" ||
    launch.manifestHash !== hold.manifestHash ||
    launch.operationId !== authority.operationId ||
    launch.intentHash !== authority.actions[launch.actionId]?.intentHash ||
    now < authority.validFrom ||
    now + 180 >= authority.validUntil
  )
    throw new Error("introduction_refused");
  const condition = exactCheck(tables.deploymentControl, previous);
  return {
    TransactItems: [
      ...introductionChecks(hold, authority, tables.deploymentControl),
      { ConditionCheck: exactCheck(tables.deploymentControl, launch) },
      {
        Update: {
          ...condition,
          UpdateExpression:
            "SET coordinatorToken = :replacementToken, coordinatorEpoch = :replacementEpoch, coordinatorExpiresAt = :replacementExpiry",
          ExpressionAttributeValues: {
            ...condition.ExpressionAttributeValues,
            ...marshall({
              ":replacementToken": replacement.runToken,
              ":replacementEpoch": replacement.epoch,
              ":replacementExpiry": now + 180,
            }),
          },
        },
      },
    ],
  };
}
import { buildRuntimeRetirementRequest } from "./deploymentControlTransactions";
import {
  runtimeRecordSchema,
  type RuntimeRecord,
} from "../types/deploymentControl";
export function buildIntroductionRenew({
  hold,
  authority,
  previous,
  now,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  previous: ControlRecord;
  now: number;
  tables: Tables;
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  controlRecordSchema.parse(previous);
  const owner = bootstrapAuthority(authority, previous.coordinatorEpoch);
  if (
    previous.coordinatorToken !== owner.runToken ||
    previous.coordinatorExpiresAt <= now ||
    now + 180 >= authority.validUntil ||
    previous.servingGeneration !== 0 ||
    Object.keys(previous.servingMembers).length ||
    previous.deployment ||
    previous.compatibleReplacement ||
    !isDeepStrictEqual(previous.maintenance, pointer(hold))
  )
    throw Error("introduction_refused");
  const condition = exactCheck(tables.deploymentControl, previous);
  return {
    TransactItems: [
      ...introductionChecks(hold, authority, tables.deploymentControl),
      {
        Update: {
          ...condition,
          UpdateExpression: "SET coordinatorExpiresAt = :renewExpiry",
          ExpressionAttributeValues: {
            ...condition.ExpressionAttributeValues,
            ...marshall({ ":renewExpiry": now + 180 }),
          },
        },
      },
    ],
  };
}
function assertFailedCandidateRuntime(
  runtime: RuntimeRecord,
  authority: IntroductionAuthority,
) {
  if (
    runtime.identity.kind !== "ecs" ||
    runtime.identity.candidateId !== authority.handoff.priorCandidateId ||
    runtime.identity.imageDigest !== authority.handoff.priorDigest ||
    runtime.role !== "candidate" ||
    runtime.authorizedGeneration !== 0 ||
    runtime.retirementRequest ||
    runtime.retirementAcknowledgment ||
    !runtime.workCounts ||
    Object.values(runtime.workCounts).some((v) => v !== 0)
  )
    throw Error("introduction_refused");
}
export function buildFailedCandidateRetirement({
  hold,
  authority,
  control,
  runtime,
  now,
  tables,
}: {
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  control: ControlRecord;
  runtime: RuntimeRecord;
  now: number;
  tables: Tables & { meetingHistory: string };
}): TransactWriteItemsCommandInput {
  validateAuthority(hold, authority);
  controlRecordSchema.parse(control);
  runtimeRecordSchema.parse(runtime);
  const replacement = authority.failedUnserved;
  if (
    !replacement ||
    control.coordinatorToken !== replacement.runToken ||
    control.coordinatorEpoch !== replacement.epoch ||
    control.coordinatorExpiresAt <= now ||
    control.servingGeneration !== 0 ||
    Object.keys(control.servingMembers).length ||
    control.deployment ||
    control.compatibleReplacement ||
    !isDeepStrictEqual(control.maintenance, pointer(hold))
  )
    throw Error("introduction_refused");
  assertFailedCandidateRuntime(runtime, authority);
  const transaction = buildRuntimeRetirementRequest(
    {
      record: runtime,
      request: {
        identity: runtime.identity,
        authorizedGeneration: 0,
        coordinatorToken: control.coordinatorToken,
        coordinatorEpoch: control.coordinatorEpoch,
      },
      now,
    },
    tables,
  );
  transaction.TransactItems![0] = {
    ConditionCheck: exactCheck(tables.deploymentControl, control),
  };
  transaction.TransactItems!.push(
    ...introductionChecks(hold, authority, tables.deploymentControl),
  );
  return transaction;
}
