import type {
  ConditionCheck,
  TransactWriteItem,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createHash } from "node:crypto";
import { stableJson } from "../utils/stableJson";
import type { ArtifactAuthority } from "../types/artifactCleanup";
import type { ControlRecord } from "../types/deploymentControl";
import type { ArtifactSafetyRecord } from "../types/artifactSafety";
import {
  validateArtifactSafetyWrite,
  artifactProofForWrite,
  type ArtifactSafetyWrite,
} from "./artifactSafetyRules";
export type { ArtifactSafetyWrite } from "./artifactSafetyRules";

export type ArtifactSafetyTables = {
  deploymentControl: string;
  meetingHistory: string;
};
export function artifactSnapshotCondition(snapshot: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const clauses = Object.entries(snapshot).map(([field, value], index) => {
    const expression = field
      .split(".")
      .map((part, offset) => {
        const key = "#f" + index + "_" + offset;
        names[key] = part;
        return key;
      })
      .join(".");
    if (value === null) return "attribute_not_exists(" + expression + ")";
    const parameter = ":v" + index;
    values[parameter] = value;
    return expression + " = " + parameter;
  });
  const expressionValues = marshall(values, { removeUndefinedValues: true });
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(expressionValues).length
      ? { ExpressionAttributeValues: expressionValues }
      : {}),
  };
}
export function artifactHistoryAttributes(
  authority: ArtifactAuthority,
): Record<string, unknown> {
  return {
    meetingId: authority.owner.meetingId,
    ownerInstanceId: authority.owner.ownerInstanceId,
    executionVersion: authority.owner.executionVersion,
    checkpoint: authority.checkpoint,
    status: authority.status,
    "completionPolicy.decision": authority.completionDecision,
    audioS3Key: authority.audioS3Key,
    chatS3Key: authority.chatS3Key,
    transcriptS3Key: authority.transcriptS3Key,
  };
}
function historyCheck(
  authority: ArtifactAuthority,
  table: string,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: marshall({
        guildId: authority.owner.guildId,
        channelId_timestamp: authority.historyKey,
      }),
      ...artifactSnapshotCondition(artifactHistoryAttributes(authority)),
    },
  };
}
export function artifactRuntimeAttributes(
  input: ArtifactSafetyWrite,
): Record<string, unknown> {
  return {
    identity: input.next.identity,
    role: input.context.runtime.role,
    authorizedGeneration: input.context.runtime.authorizedGeneration,
    retirementRequest: input.context.runtime.retirementRequest ?? null,
  };
}
function runtimeCheck(
  input: ArtifactSafetyWrite,
  table: string,
): TransactWriteItem {
  const condition: ConditionCheck = {
    TableName: table,
    Key: marshall({
      pk: "ENV",
      sk: "RUNTIME#" + input.next.identity.instanceId,
    }),
    ...artifactSnapshotCondition(artifactRuntimeAttributes(input)),
  };
  if (!["heartbeat", "block", "cancel"].includes(input.purpose)) {
    condition.ConditionExpression +=
      " AND protection.#nativeIdentity = :nativeIdentity AND protection.expiresAt > :nativeNow";
    condition.ExpressionAttributeNames = {
      ...condition.ExpressionAttributeNames,
      "#nativeIdentity": "identity",
    };
    condition.ExpressionAttributeValues = {
      ...condition.ExpressionAttributeValues,
      ...marshall({
        ":nativeIdentity": input.next.identity,
        ":nativeNow": input.now,
      }),
    };
  }
  return { ConditionCheck: condition };
}
export function artifactControlAttributes(
  control: ControlRecord,
): Record<string, unknown> {
  return {
    coordinatorToken: control.coordinatorToken,
    coordinatorEpoch: control.coordinatorEpoch,
    servingGeneration: control.servingGeneration,
    servingMembers: control.servingMembers,
    deployment: control.deployment ?? null,
  };
}
export function artifactPreparationControl(
  control: ControlRecord,
  now: number,
  phase: "warming" | "complete",
): ControlRecord {
  if (!control.deployment || control.deployment.phase !== "preparing")
    throw new Error("Artifact preparation is not launchable");
  return {
    ...control,
    deployment: { ...control.deployment, phase, updatedAt: now },
  };
}
function controlOperation(
  input: ArtifactSafetyWrite,
  table: string,
): TransactWriteItem | undefined {
  if (input.context.kind === "runtime") return undefined;
  const condition: ConditionCheck = {
    TableName: table,
    Key: marshall({ pk: "ENV", sk: "CONTROL" }),
    ...artifactSnapshotCondition(
      artifactControlAttributes(input.context.control),
    ),
  };
  if (input.context.kind !== "activating") {
    condition.ConditionExpression += " AND coordinatorExpiresAt > :controlNow";
    condition.ExpressionAttributeValues = {
      ...condition.ExpressionAttributeValues,
      ...marshall({ ":controlNow": input.now }),
    };
  }
  if (!["consume", "cancel_ack"].includes(input.purpose))
    return { ConditionCheck: condition };
  const next = artifactPreparationControl(
    input.context.control,
    input.now,
    input.purpose === "consume" ? "warming" : "complete",
  );
  return {
    Update: {
      ...condition,
      UpdateExpression: "SET #nextDeployment = :nextDeployment",
      ExpressionAttributeNames: {
        ...condition.ExpressionAttributeNames,
        "#nextDeployment": "deployment",
      },
      ExpressionAttributeValues: {
        ...condition.ExpressionAttributeValues,
        ...marshall({ ":nextDeployment": next.deployment }),
      },
    },
  };
}
export function artifactExpectedAttributes(
  expected: ArtifactSafetyRecord,
): Record<string, unknown> {
  return {
    identity: expected.identity,
    revision: expected.revision,
    state: expected.state,
    request: "request" in expected ? expected.request : null,
    proof: "proof" in expected ? expected.proof : null,
    startup: expected.startup,
  };
}
function recordPut(
  input: ArtifactSafetyWrite,
  table: string,
): TransactWriteItem {
  const condition = input.expected
    ? artifactSnapshotCondition(artifactExpectedAttributes(input.expected))
    : {
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      };
  return {
    Put: {
      TableName: table,
      Item: marshall(input.next, { removeUndefinedValues: true }),
      ...condition,
    },
  };
}
export function buildArtifactSafetyTransaction(
  input: ArtifactSafetyWrite,
  tables: ArtifactSafetyTables,
): TransactWriteItemsCommandInput {
  validateArtifactSafetyWrite(input);
  const items = [
    recordPut(input, tables.deploymentControl),
    runtimeCheck(input, tables.deploymentControl),
  ];
  const control = controlOperation(input, tables.deploymentControl);
  if (control) items.push(control);
  const proof = artifactProofForWrite(input);
  for (const authority of proof?.snapshot.authorities ?? [])
    items.push(historyCheck(authority, tables.meetingHistory));
  return {
    TransactItems: items,
    ClientRequestToken: createHash("sha256")
      .update(stableJson(input))
      .digest("hex")
      .slice(0, 32),
  };
}
