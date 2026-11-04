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
import {
  artifactControlOperation,
  artifactRecordPut,
  artifactSnapshotCondition,
  type ArtifactSafetyTables,
} from "./artifactSafetyTransactions";

/**
 * A legacy source never seals admission, so these counters are the only
 * signal that it could still be producing files the attested backup lacks.
 */
export const LEGACY_QUIET_WORK = ["recording", "pending_admission"] as const;
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
  seal: { from: ["requested"], to: "sealed" },
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
function requireSource(input: LegacyArtifactWrite) {
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
    LEGACY_QUIET_WORK.some((kind) => runtime.workCounts?.[kind] !== 0)
  )
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
  requireSource(input);
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
            ...Object.fromEntries(
              LEGACY_QUIET_WORK.map((kind) => ["workCounts." + kind, 0]),
            ),
          }
        : {}),
    }),
  };
  if (quiet) {
    condition.ConditionExpression += " AND heartbeatAt > :legacyFresh";
    condition.ExpressionAttributeValues = {
      ...condition.ExpressionAttributeValues,
      ...marshall({ ":legacyFresh": input.now - ARTIFACT_PROOF_SECONDS }),
    };
  }
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
