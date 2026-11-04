import type {
  ConditionCheck,
  TransactWriteItem,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createHash } from "node:crypto";
import { stableJson } from "../utils/stableJson";
import {
  ARTIFACT_PROOF_SECONDS,
  artifactSafetyRecordSchema,
  type ArtifactSafetyRecord,
  type ArtifactStorageSnapshot,
  type LegacyAttestation,
} from "../types/artifactSafety";
import {
  controlRecordSchema,
  runtimeRecordSchema,
  sameRuntimeIdentity,
  type ControlRecord,
  type RuntimeRecord,
} from "../types/deploymentControl";
import { MAXIMUM_MEETING_DURATION } from "../constants";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import {
  artifactControlOperation,
  artifactRecordPut,
  artifactSnapshotCondition,
  requireRuntimeProtection,
  type ArtifactSafetyTables,
} from "./artifactSafetyTransactions";

const TERMINAL_STATUSES: string[] = [
  MEETING_STATUS.COMPLETE,
  MEETING_STATUS.CANCELLED,
  MEETING_STATUS.FAILED,
];
export type LegacyMeetingRow = {
  timestamp: string;
  status?: string;
  audioS3Key?: string;
};
/** Earliest start of a meeting that could still have been live at the copy. */
export function legacyMeetingWindowStart(capturedAt: number) {
  return new Date(capturedAt * 1000 - MAXIMUM_MEETING_DURATION).toISOString();
}
/**
 * Meetings from that window the copy may not cover: any that started at or
 * after the copy (second floored, so ties count), and any earlier one that
 * is not yet terminal with its audio key recorded.
 */
export function uncoveredLegacyMeetings(
  rows: LegacyMeetingRow[],
  capturedAt: number,
) {
  return rows.filter(
    (row) =>
      !(Date.parse(row.timestamp) < capturedAt * 1000) ||
      !TERMINAL_STATUSES.includes(row.status ?? "") ||
      !row.audioS3Key,
  );
}
/** The ECS task id a manifest must name, from the source's exact identity. */
export function legacyTaskId(runtime: RuntimeRecord) {
  if (runtime.identity.kind !== "ecs")
    throw new Error("Legacy attestation requires an ECS source");
  return runtime.identity.taskArn.split("/").pop() ?? "";
}
/** A manifest belongs to the source by its `task-<id>/` path or by naming the instance. */
export function legacyManifestBound(
  manifestKey: string,
  manifestSource: string,
  runtime: RuntimeRecord,
) {
  return (
    manifestKey.includes(`task-${legacyTaskId(runtime)}/`) ||
    manifestSource === runtime.identity.instanceId
  );
}
export type LegacyArtifactPurpose =
  "attest" | "request" | "seal" | "consume" | "cancel";
export type LegacyArtifactWrite = {
  purpose: LegacyArtifactPurpose;
  expected?: ArtifactSafetyRecord;
  next: ArtifactSafetyRecord;
  runtime: RuntimeRecord;
  control: ControlRecord;
  now: number;
};
type State = ArtifactSafetyRecord["state"];
const transitions: Record<
  LegacyArtifactPurpose,
  { from: Array<State | "missing">; to: State }
> = {
  attest: { from: ["missing", "attested_legacy"], to: "attested_legacy" },
  request: { from: ["attested_legacy"], to: "requested" },
  seal: { from: ["requested", "sealed"], to: "sealed" },
  consume: { from: ["sealed"], to: "consumed" },
  cancel: {
    from: ["attested_legacy", "requested", "sealed"],
    to: "attested_legacy",
  },
};
const CONTROL_PHASES: Partial<
  Record<LegacyArtifactPurpose, "warming" | "complete">
> = { consume: "warming", cancel: "complete" };

export function legacyAttestedSnapshot(
  attestation: LegacyAttestation,
): ArtifactStorageSnapshot {
  return {
    inventoryDigest: attestation.manifestSha256,
    fileCount: attestation.fileCount,
    byteLength: attestation.byteLength,
    pendingDirectories: 0,
    authorities: [],
  };
}
const same = (left: unknown, right: unknown) =>
  stableJson(left) === stableJson(right);
const requestOf = (row: ArtifactSafetyRecord | undefined) =>
  row && "request" in row ? row.request : undefined;

function requireTransition({ purpose, expected, next }: LegacyArtifactWrite) {
  const rule = transitions[purpose];
  if (
    !rule ||
    !rule.from.includes(expected?.state ?? "missing") ||
    next.state !== rule.to ||
    next.revision !== (expected ? expected.revision + 1 : 0)
  )
    throw new Error("Legacy artifact transition is not authorized");
}
function requireAttestation(input: LegacyArtifactWrite): LegacyAttestation {
  const { expected, next, purpose, now } = input;
  const attestation = next.attestation;
  if (!attestation || (expected && !expected.attestation))
    throw new Error("Runtime-written artifact rows use the runtime protocol");
  if (
    purpose === "attest"
      ? attestation.verifiedAt !== now
      : !same(attestation, expected?.attestation)
  )
    throw new Error("Legacy attestation binding changed");
  if (purpose !== "cancel" && attestation.expiresAt <= now)
    throw new Error("Legacy attestation expired");
  return attestation;
}
function requireCurrentRow({ expected, next, now }: LegacyArtifactWrite) {
  if (
    next.startup.kind !== "pending" ||
    next.heartbeatAt > now ||
    next.freshUntil <= now ||
    (expected && !sameRuntimeIdentity(expected.identity, next.identity))
  )
    throw new Error("Legacy artifact row is not current");
}
function requireSource(
  input: LegacyArtifactWrite,
  attestation: LegacyAttestation,
) {
  const { runtime, control, next, now } = input;
  const member = control.servingMembers[next.identity.instanceId];
  if (
    !sameRuntimeIdentity(runtime.identity, next.identity) ||
    !member ||
    !sameRuntimeIdentity(member, next.identity)
  )
    throw new Error("Legacy source is not a serving member");
  if (input.purpose === "cancel") return;
  if (
    runtime.role !== "serving" ||
    runtime.authorizedGeneration !== control.servingGeneration ||
    runtime.retirementRequest ||
    runtime.heartbeatAt <= now - ARTIFACT_PROOF_SECONDS ||
    !sameRuntimeIdentity(runtime.protection.identity, next.identity) ||
    runtime.protection.expiresAt <= now ||
    legacyTaskId(runtime) !== attestation.taskId
  )
    throw new Error("Legacy source is not a protected serving runtime");
  requireQuiet(runtime);
}
function requireQuiet(runtime: RuntimeRecord) {
  if (runtime.workCounts?.recording !== 0)
    throw new Error("Legacy source is not a quiet serving runtime");
}
function requestBound(
  request: NonNullable<ReturnType<typeof requestOf>>,
  control: ControlRecord,
) {
  return (
    request.coordinatorToken === control.coordinatorToken &&
    request.coordinatorToken === control.deployment?.runToken &&
    request.coordinatorEpoch === control.coordinatorEpoch &&
    request.servingGeneration === control.servingGeneration &&
    request.servingGeneration === control.deployment?.originalGeneration
  );
}
function requirePreparation(input: LegacyArtifactWrite) {
  const { control, next, now, purpose } = input;
  const d = control.deployment;
  if (
    !d ||
    d.phase !== "preparing" ||
    !sameRuntimeIdentity(d.outgoing, next.identity) ||
    control.coordinatorExpiresAt <= now
  )
    throw new Error("Legacy preparation authority changed");
  const request = requestOf(next) ?? requestOf(input.expected);
  if (request && !requestBound(request, control))
    throw new Error("Legacy request authority changed");
  if (purpose === "cancel") return;
  if (!request || request.expiresAt <= now)
    throw new Error("Legacy preparation expired");
  if (
    purpose === "request"
      ? request.requestedAt > now
      : !same(request, requestOf(input.expected))
  )
    throw new Error("Legacy request binding changed");
}
function requireSeal(
  { next, now }: LegacyArtifactWrite,
  attestation: LegacyAttestation,
) {
  if (
    next.state !== "sealed" ||
    next.proof.provenAt > now ||
    next.proof.expiresAt <= now ||
    next.proof.expiresAt > attestation.expiresAt ||
    !same(next.proof.snapshot, legacyAttestedSnapshot(attestation))
  )
    throw new Error("Legacy proof is not derived from the attestation");
}
function requireConsume({ expected, next, now }: LegacyArtifactWrite) {
  if (
    expected?.state !== "sealed" ||
    next.state !== "consumed" ||
    !same(expected.proof, next.proof) ||
    next.consumedAt > now ||
    next.consumedAt < next.proof.provenAt ||
    next.proof.expiresAt <= now ||
    next.retirementVerification
  )
    throw new Error("Legacy proof cannot be consumed");
}
export function validateLegacyArtifactWrite(input: LegacyArtifactWrite) {
  artifactSafetyRecordSchema.parse(input.next);
  if (input.expected) artifactSafetyRecordSchema.parse(input.expected);
  runtimeRecordSchema.parse(input.runtime);
  controlRecordSchema.parse(input.control);
  if (!Number.isSafeInteger(input.now) || input.now < 0)
    throw new Error("Invalid artifact clock");
  requireTransition(input);
  const attestation = requireAttestation(input);
  requireCurrentRow(input);
  requireSource(input, attestation);
  if (input.purpose !== "attest") requirePreparation(input);
  if (input.purpose === "seal") requireSeal(input, attestation);
  if (input.purpose === "consume") requireConsume(input);
}
function runtimeCheck(
  input: LegacyArtifactWrite,
  table: string,
): TransactWriteItem {
  const quiet = input.purpose !== "cancel";
  const condition: ConditionCheck = {
    TableName: table,
    Key: marshall({
      pk: "ENV",
      sk: "RUNTIME#" + input.next.identity.instanceId,
    }),
    ...artifactSnapshotCondition({
      identity: input.next.identity,
      ...(quiet
        ? {
            role: "serving",
            authorizedGeneration: input.control.servingGeneration,
            retirementRequest: null,
            "workCounts.recording": 0,
          }
        : {}),
    }),
  };
  if (!quiet) return { ConditionCheck: condition };
  condition.ConditionExpression += " AND heartbeatAt > :legacyFresh";
  condition.ExpressionAttributeValues = {
    ...condition.ExpressionAttributeValues,
    ...marshall({ ":legacyFresh": input.now - ARTIFACT_PROOF_SECONDS }),
  };
  requireRuntimeProtection(condition, input.next.identity, input.now);
  return { ConditionCheck: condition };
}
/**
 * The coordinator writes the source's artifact row itself, conditioned on the
 * legacy runtime row still reporting a quiet serving runtime and on Control.
 */
export function buildLegacyArtifactTransaction(
  input: LegacyArtifactWrite,
  tables: ArtifactSafetyTables,
): TransactWriteItemsCommandInput {
  validateLegacyArtifactWrite(input);
  return {
    TransactItems: [
      artifactRecordPut(input, tables.deploymentControl, {
        attestation: input.expected?.attestation ?? null,
      }),
      runtimeCheck(input, tables.deploymentControl),
      artifactControlOperation(
        input.control,
        tables.deploymentControl,
        input.now,
        {
          leased: input.purpose !== "attest",
          phase: CONTROL_PHASES[input.purpose],
        },
      ),
    ],
    ClientRequestToken: createHash("sha256")
      .update(stableJson(input))
      .digest("hex")
      .slice(0, 32),
  };
}
