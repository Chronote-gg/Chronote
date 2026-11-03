import { stableJson } from "../utils/stableJson";
import {
  artifactSafetyRecordSchema,
  type ArtifactSafetyRecord,
  type ArtifactStorageProof,
} from "../types/artifactSafety";
import {
  controlRecordSchema,
  runtimeRecordSchema,
  sameRuntimeIdentity,
  type ControlRecord,
  type RuntimeRecord,
  type RetirementRequest,
} from "../types/deploymentControl";

function sameArtifactValue(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

export type ArtifactSafetyPurpose =
  | "initialize"
  | "heartbeat"
  | "startup"
  | "renew_startup"
  | "activate"
  | "request"
  | "drain"
  | "seal"
  | "block"
  | "consume"
  | "cancel"
  | "cancel_ack"
  | "retirement";
export type ArtifactSafetyContext =
  | { kind: "runtime"; runtime: RuntimeRecord }
  | { kind: "preparing"; runtime: RuntimeRecord; control: ControlRecord }
  | { kind: "activating"; runtime: RuntimeRecord; control: ControlRecord }
  | {
      kind: "retiring";
      runtime: RuntimeRecord;
      control: ControlRecord;
      request: RetirementRequest;
    };
export type ArtifactSafetyWrite = {
  purpose: ArtifactSafetyPurpose;
  expected?: ArtifactSafetyRecord;
  next: ArtifactSafetyRecord;
  context: ArtifactSafetyContext;
  now: number;
};
type Rule = {
  from: Array<ArtifactSafetyRecord["state"] | "missing">;
  to: ArtifactSafetyRecord["state"][];
  guard: ArtifactSafetyContext["kind"];
  roles: RuntimeRecord["role"][];
};
const rules: Record<ArtifactSafetyPurpose, Rule> = {
  initialize: {
    from: ["missing"],
    to: ["idle"],
    guard: "runtime",
    roles: ["candidate", "serving"],
  },
  heartbeat: {
    from: [
      "idle",
      "requested",
      "draining",
      "sealed",
      "blocked",
      "consumed",
      "cancel_requested",
      "cancelled",
      "retirement_safe",
    ],
    to: [
      "idle",
      "requested",
      "draining",
      "sealed",
      "blocked",
      "consumed",
      "cancel_requested",
      "cancelled",
      "retirement_safe",
    ],
    guard: "runtime",
    roles: ["candidate", "serving", "draining", "releasing", "retired"],
  },
  startup: {
    from: ["idle", "cancelled", "consumed", "retirement_safe"],
    to: ["idle"],
    guard: "runtime",
    roles: ["candidate"],
  },
  renew_startup: {
    from: ["idle"],
    to: ["idle"],
    guard: "activating",
    roles: ["serving"],
  },
  activate: {
    from: ["idle"],
    to: ["idle"],
    guard: "activating",
    roles: ["serving"],
  },
  request: {
    from: ["idle", "cancelled", "blocked"],
    to: ["requested"],
    guard: "preparing",
    roles: ["serving"],
  },
  drain: {
    from: ["requested", "draining"],
    to: ["draining"],
    guard: "preparing",
    roles: ["serving"],
  },
  seal: {
    from: ["draining"],
    to: ["sealed"],
    guard: "preparing",
    roles: ["serving"],
  },
  block: {
    from: ["requested", "draining", "sealed", "blocked"],
    to: ["blocked"],
    guard: "runtime",
    roles: ["serving", "draining"],
  },
  consume: {
    from: ["sealed"],
    to: ["consumed"],
    guard: "preparing",
    roles: ["serving"],
  },
  cancel: {
    from: ["requested", "draining", "sealed", "blocked"],
    to: ["cancel_requested"],
    guard: "preparing",
    roles: ["serving"],
  },
  cancel_ack: {
    from: ["cancel_requested"],
    to: ["cancelled"],
    guard: "preparing",
    roles: ["serving"],
  },
  retirement: {
    from: [
      "idle",
      "requested",
      "draining",
      "sealed",
      "blocked",
      "consumed",
      "cancel_requested",
      "cancelled",
      "retirement_safe",
    ],
    to: ["consumed", "retirement_safe"],
    guard: "retiring",
    roles: ["draining", "releasing"],
  },
};

function isServingIdentity(
  control: ControlRecord,
  identity: RuntimeRecord["identity"],
) {
  const member = control.servingMembers[identity.instanceId];
  return member !== undefined && sameRuntimeIdentity(member, identity);
}

function requirePreparationDeadline(
  input: ArtifactSafetyWrite,
  request: Extract<ArtifactSafetyRecord, { state: "requested" }>["request"],
) {
  if (
    !["cancel", "cancel_ack"].includes(input.purpose) &&
    request.expiresAt <= input.now
  )
    throw new Error("Artifact preparation expired");
  if (request.requestedAt > input.now)
    throw new Error("Artifact request is from the future");
  if (
    input.purpose === "request" &&
    (!input.expected || input.expected.freshUntil <= input.now)
  )
    throw new Error("Artifact capability expired");
}
function requirePreparation(
  input: ArtifactSafetyWrite,
  control: ControlRecord,
) {
  const row = input.next;
  if (!("request" in row)) throw new Error("Artifact request missing");
  const request = row.request;
  const deployment = control.deployment;
  if (
    control.coordinatorToken !== request.coordinatorToken ||
    control.coordinatorEpoch !== request.coordinatorEpoch ||
    control.servingGeneration !== request.servingGeneration ||
    control.coordinatorExpiresAt <= input.now ||
    !isServingIdentity(control, row.identity)
  )
    throw new Error("Artifact coordinator or source authority changed");
  if (
    !deployment ||
    deployment.phase !== "preparing" ||
    deployment.runToken !== request.coordinatorToken ||
    deployment.originalGeneration !== request.servingGeneration ||
    !sameRuntimeIdentity(deployment.outgoing, row.identity)
  )
    throw new Error("Artifact preparation may already have launched");
  if (
    input.context.runtime.authorizedGeneration !== request.servingGeneration ||
    row.startup.kind !== "active"
  )
    throw new Error("Artifact source is not the active generation");
  requirePreparationDeadline(input, request);
}
function requireServing(input: ArtifactSafetyWrite, control: ControlRecord) {
  if (
    control.servingGeneration !== input.context.runtime.authorizedGeneration ||
    !isServingIdentity(control, input.next.identity)
  )
    throw new Error("Artifact activation is not serving");
}
function requireRetirement(
  input: ArtifactSafetyWrite,
  context: Extract<ArtifactSafetyContext, { kind: "retiring" }>,
) {
  if (
    context.control.coordinatorToken !== context.request.coordinatorToken ||
    context.control.coordinatorEpoch !== context.request.coordinatorEpoch ||
    context.control.coordinatorExpiresAt <= input.now ||
    context.control.servingMembers[input.next.identity.instanceId] ||
    !sameRuntimeIdentity(context.request.identity, input.next.identity) ||
    context.runtime.authorizedGeneration !==
      context.request.authorizedGeneration ||
    !sameArtifactValue(context.runtime.retirementRequest, context.request)
  )
    throw new Error("Artifact retirement authority changed");
}
function requireContext(input: ArtifactSafetyWrite) {
  const context = input.context;
  runtimeRecordSchema.parse(context.runtime);
  if (!sameRuntimeIdentity(context.runtime.identity, input.next.identity))
    throw new Error("Artifact runtime identity changed");
  if (context.kind === "runtime") return;
  controlRecordSchema.parse(context.control);
  if (context.kind === "preparing") requirePreparation(input, context.control);
  else if (context.kind === "activating")
    requireServing(input, context.control);
  else requireRetirement(input, context);
}
function stableRecord(row: ArtifactSafetyRecord) {
  return { ...row, revision: 0, heartbeatAt: 0, freshUntil: 0 };
}
function requireBinding(input: ArtifactSafetyWrite) {
  const { expected, next, purpose } = input;
  if (next.revision !== (expected ? expected.revision + 1 : 0))
    throw new Error("Artifact revision changed");
  if (expected && !sameRuntimeIdentity(expected.identity, next.identity))
    throw new Error("Artifact identity changed");
  if (
    expected &&
    "request" in expected &&
    !["request", "startup", "retirement"].includes(purpose) &&
    (!("request" in next) || !sameArtifactValue(expected.request, next.request))
  )
    throw new Error("Artifact request binding changed");
  if (
    expected &&
    purpose === "heartbeat" &&
    !sameArtifactValue(stableRecord(expected), stableRecord(next))
  )
    throw new Error("Heartbeat cannot change artifact state");
}
function requireClock(input: ArtifactSafetyWrite) {
  if (!Number.isSafeInteger(input.now) || input.now < 0)
    throw new Error("Invalid artifact clock");
  if (["request", "cancel", "consume"].includes(input.purpose)) {
    if (
      !input.expected ||
      input.next.heartbeatAt !== input.expected.heartbeatAt ||
      input.next.freshUntil !== input.expected.freshUntil
    )
      throw new Error("Coordinator cannot forge runtime liveness");
  } else if (input.next.heartbeatAt !== input.now)
    throw new Error("Runtime liveness is not current");
}
function requireStartupState(input: ArtifactSafetyWrite) {
  if (
    input.purpose === "renew_startup" &&
    input.expected?.startup.kind !== "sealed"
  )
    throw new Error("Startup renewal requires a previously sealed proof");
  if (input.purpose === "initialize") {
    if (input.next.startup.kind !== "pending")
      throw new Error("Artifact startup has not been verified");
  } else if (input.purpose === "activate") {
    if (
      input.expected?.startup.kind !== "sealed" ||
      input.next.startup.kind !== "active" ||
      input.next.startup.activatedAt > input.now
    )
      throw new Error("Artifact activation is not verified");
  } else if (
    !["startup", "renew_startup"].includes(input.purpose) &&
    input.expected &&
    !sameArtifactValue(input.expected.startup, input.next.startup)
  )
    throw new Error("Artifact transition cannot change startup capability");
}
function requireConsume(input: ArtifactSafetyWrite) {
  const { expected, next } = input;
  if (
    expected?.state !== "sealed" ||
    next.state !== "consumed" ||
    !sameArtifactValue(expected.proof, next.proof) ||
    next.consumedAt !== input.now ||
    next.retirementVerification ||
    expected.freshUntil <= input.now
  )
    throw new Error("Artifact proof cannot be consumed");
}
function requireRetirementProof(input: ArtifactSafetyWrite) {
  const { expected, next, context } = input;
  if (
    !expected ||
    context.kind !== "retiring" ||
    !("retirementVerification" in next) ||
    !next.retirementVerification ||
    !sameArtifactValue(next.retirementVerification.request, context.request)
  )
    throw new Error("Retirement verification missing");
  if (expected.state === "consumed") {
    if (
      next.state !== "consumed" ||
      !sameArtifactValue(next.proof, expected.proof) ||
      !sameArtifactValue(next.request, expected.request) ||
      !sameArtifactValue(
        next.retirementVerification.proof.snapshot,
        expected.proof.snapshot,
      )
    )
      throw new Error("Consumed artifact inventory changed");
  } else if (next.state !== "retirement_safe")
    throw new Error("Fresh retirement proof missing");
}
export function artifactProofForWrite(
  input: ArtifactSafetyWrite,
): ArtifactStorageProof | undefined {
  if (
    ["startup", "renew_startup"].includes(input.purpose) &&
    input.next.startup.kind === "sealed"
  )
    return input.next.startup.proof;
  if (input.purpose === "activate" && input.expected?.startup.kind === "sealed")
    return input.expected.startup.proof;
  if (["seal", "consume"].includes(input.purpose) && "proof" in input.next)
    return input.next.proof;
  if (input.purpose === "retirement" && "retirementVerification" in input.next)
    return input.next.retirementVerification?.proof;
  return undefined;
}
function requireProof(input: ArtifactSafetyWrite) {
  const proof = artifactProofForWrite(input);
  if (
    [
      "startup",
      "renew_startup",
      "activate",
      "seal",
      "consume",
      "retirement",
    ].includes(input.purpose) &&
    !proof
  )
    throw new Error("Artifact storage proof missing");
  if (proof && (proof.provenAt > input.now || proof.expiresAt <= input.now))
    throw new Error("Artifact proof is stale or from the future");
  if (Buffer.byteLength(JSON.stringify(input.next)) > 128 * 1024)
    throw new Error("Artifact proof exceeds its byte bound");
}
export function validateArtifactSafetyWrite(input: ArtifactSafetyWrite) {
  artifactSafetyRecordSchema.parse(input.next);
  if (input.expected) artifactSafetyRecordSchema.parse(input.expected);
  const rule = rules[input.purpose];
  if (
    !rule ||
    !rule.from.includes(input.expected?.state ?? "missing") ||
    !rule.to.includes(input.next.state) ||
    input.context.kind !== rule.guard ||
    !rule.roles.includes(input.context.runtime.role)
  )
    throw new Error("Artifact transition is not authorized");
  requireClock(input);
  requireStartupState(input);
  requireBinding(input);
  requireContext(input);
  if (input.purpose === "consume") requireConsume(input);
  if (input.purpose === "retirement") requireRetirementProof(input);
  requireProof(input);
}
