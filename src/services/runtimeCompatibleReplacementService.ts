import { isDeepStrictEqual } from "node:util";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import {
  controlRecordSchema,
  runtimeRecordSchema,
  sameRuntimeIdentity,
  type CompatibleReplacementInput,
  type RuntimeRecord,
} from "../types/deploymentControl";

function ready(row: RuntimeRecord, input: CompatibleReplacementInput) {
  return (
    row.readiness.observedEpoch === input.control.coordinatorEpoch &&
    row.readiness.observedGeneration === input.control.servingGeneration &&
    row.authorizedGeneration === input.control.servingGeneration &&
    row.readiness.provenAt <= input.now &&
    row.readiness.expiresAt > input.now &&
    row.protection.provenAt <= input.now &&
    row.protection.expiresAt > input.now &&
    row.readiness.cacheReady &&
    row.readiness.dependenciesReady &&
    (row.readiness.runtimeMode === "api" || row.readiness.gatewayReady) &&
    !row.expiresAt &&
    !row.retirementRequest &&
    !row.retirementAcknowledgment
  );
}
function terminalAuthority(input: CompatibleReplacementInput) {
  const { control } = input;
  const deployment = control.deployment;
  if (
    !deployment ||
    deployment.phase !== "complete" ||
    !deployment.candidate ||
    control.coordinatorExpiresAt > input.now
  )
    throw new Error(
      "Compatible replacement requires completed deployment authority",
    );
  const continuation = control.compatibleReplacement;
  if (continuation?.runToken === deployment.runToken) {
    if (
      continuation.servingGeneration !== control.servingGeneration ||
      !isDeepStrictEqual(continuation.servingMembers, control.servingMembers)
    )
      throw new Error("Replacement authority changed");
    return;
  }
  const expected = Object.fromEntries(
    [
      ...deployment.originalMembers.filter(
        (row) => row.instanceId !== deployment.outgoing.instanceId,
      ),
      deployment.candidate,
    ].map((row) => [row.instanceId, row]),
  );
  if (
    control.servingGeneration !== deployment.originalGeneration + 1 ||
    !isDeepStrictEqual(expected, control.servingMembers)
  )
    throw new Error(
      "Terminal deployment does not authorize selected generation",
    );
}
function assertOutgoingCompatibility(
  outgoing: RuntimeRecord,
  candidate: RuntimeRecord,
  control: CompatibleReplacementInput["control"],
  now: number,
) {
  if (
    outgoing.identity.kind !== "ecs" ||
    candidate.identity.kind !== "ecs" ||
    outgoing.identity.taskArn === candidate.identity.taskArn ||
    outgoing.identity.instanceId === candidate.identity.instanceId ||
    outgoing.identity.imageDigest !== candidate.identity.imageDigest ||
    outgoing.identity.candidateId !== candidate.identity.candidateId ||
    outgoing.identity.protocolVersion !== candidate.identity.protocolVersion ||
    outgoing.role !== "serving" ||
    outgoing.authorizedGeneration !== control.servingGeneration ||
    outgoing.readiness.expiresAt > now ||
    outgoing.retirementRequest ||
    outgoing.retirementAcknowledgment
  )
    throw new Error("Outgoing runtime is fresh or incompatible");
}
function selectedMembers(input: CompatibleReplacementInput) {
  const { control, members, candidate } = input;
  if (
    members.length !== Object.keys(control.servingMembers).length ||
    new Set(members.map((row) => row.identity.instanceId)).size !==
      members.length ||
    members.some(
      (row) =>
        !control.servingMembers[row.identity.instanceId] ||
        !sameRuntimeIdentity(
          control.servingMembers[row.identity.instanceId],
          row.identity,
        ),
    )
  )
    throw new Error("Incomplete selected runtime snapshot");
  const overlapping = members.filter(
    (row) =>
      row.readiness.runtimeMode === candidate.readiness.runtimeMode ||
      row.readiness.runtimeMode === "all" ||
      candidate.readiness.runtimeMode === "all",
  );
  if (
    overlapping.length !== 1 ||
    overlapping[0].readiness.runtimeMode !== candidate.readiness.runtimeMode
  )
    throw new Error("Replacement runtime mode is ambiguous");
  const outgoing = overlapping[0];
  assertOutgoingCompatibility(outgoing, candidate, control, input.now);
  const retained = members.filter((row) => row !== outgoing);
  if (retained.some((row) => row.role !== "serving" || !ready(row, input)))
    throw new Error("Retained runtime is not ready");
  return { outgoing, retained };
}
/** Admission handoff only: no death, lease, voice or work settlement is inferred. */
export function planCompatibleReplacement(input: CompatibleReplacementInput) {
  input = {
    ...input,
    control: controlRecordSchema.parse(input.control),
    candidate: runtimeRecordSchema.parse(input.candidate),
    members: input.members.map((row) => runtimeRecordSchema.parse(row)),
  };
  if (
    input.control.runtimeEnvironment !== "ecs" ||
    input.candidate.identity.kind !== "ecs" ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    input.candidate.role !== "candidate" ||
    !ready(input.candidate, input) ||
    !input.candidate.workCounts ||
    Object.values(input.candidate.workCounts).some((count) => count !== 0)
  )
    throw new Error("Compatible candidate is not ready");
  terminalAuthority(input);
  const { outgoing, retained } = selectedMembers(input);
  const servingGeneration = input.control.servingGeneration + 1;
  const servingMembers = Object.fromEntries(
    [input.candidate, ...retained].map((row) => [
      row.identity.instanceId,
      row.identity,
    ]),
  );
  const control = controlRecordSchema.parse({
    ...input.control,
    servingGeneration,
    servingMembers,
    compatibleReplacement: {
      runToken: input.control.deployment!.runToken,
      servingGeneration,
      servingMembers,
    },
  });
  const runtimes: RuntimeRecord[] = [
    { ...outgoing, role: "draining" },
    ...[input.candidate, ...retained].map((row) => ({
      ...row,
      role: "serving" as const,
      authorizedGeneration: servingGeneration,
    })),
  ];
  // Each runtime must refresh its own observed generation; this transaction manufactures no readiness.
  return { control, runtimes };
}
export async function admitCompatibleReplacement(
  repository: DeploymentControlRepository,
  candidate: RuntimeRecord,
  now: number,
): Promise<boolean> {
  if (candidate.role !== "candidate" || candidate.identity.kind !== "ecs")
    return false;
  const control = await repository.getRecord("ENV", "CONTROL");
  if (control?.recordType !== "control") return false;
  const members: RuntimeRecord[] = [];
  for (const identity of Object.values(control.servingMembers)) {
    const row = await repository.getRecord(
      "ENV",
      `RUNTIME#${identity.instanceId}`,
    );
    if (row?.recordType !== "runtime") return false;
    members.push(row);
  }
  const input = { control, candidate, members, now };
  let expected: ReturnType<typeof planCompatibleReplacement>;
  try {
    expected = planCompatibleReplacement(input);
  } catch {
    return false;
  }
  try {
    return (await repository.replaceCompatibleRuntime(input)) === "applied";
  } catch {
    // Lost response: exact readback authorizes no repeat transition or external operation.
    const observed = await repository.getRecord("ENV", "CONTROL");
    if (
      observed?.recordType !== "control" ||
      !isDeepStrictEqual(controlRecordSchema.parse(observed), expected.control)
    )
      return false;
    const current = await repository.getRecord("ENV", candidate.sk);
    return (
      current?.recordType === "runtime" &&
      current.role === "serving" &&
      sameRuntimeIdentity(current.identity, candidate.identity) &&
      current.authorizedGeneration === expected.control.servingGeneration
    );
  }
}
