import {
  controlRecordSchema,
  runtimeRecordSchema,
  sameRuntimeIdentity,
  type LocalBootstrapInput,
  type RuntimeRecord,
} from "../types/deploymentControl";

function ready(row: RuntimeRecord, input: LocalBootstrapInput): boolean {
  return (
    row.readiness.observedGeneration === input.control.servingGeneration &&
    row.readiness.observedEpoch === input.control.coordinatorEpoch &&
    (row.readiness.runtimeMode === "api" || row.readiness.gatewayReady) &&
    row.readiness.cacheReady &&
    row.readiness.dependenciesReady &&
    row.readiness.provenAt <= input.now &&
    row.readiness.expiresAt > input.now &&
    row.protection.provenAt <= input.now &&
    row.protection.expiresAt > input.now &&
    row.expiresAt === undefined
  );
}

/** Eligibility only. Expired proofs never settle a lease or a Discord operation. */
export function planLocalBootstrap(input: LocalBootstrapInput) {
  const { control, candidate, members, now } = input;
  controlRecordSchema.parse(control);
  runtimeRecordSchema.parse(candidate);
  members.forEach((row) => runtimeRecordSchema.parse(row));
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    control.runtimeEnvironment !== "local" ||
    candidate.identity.kind !== "local" ||
    members.some((row) => row.identity.kind !== "local")
  )
    throw new Error(
      "Bootstrap requires explicitly local control and identities",
    );
  if (
    candidate.role !== "candidate" ||
    !ready(candidate, input) ||
    control.servingMembers[candidate.identity.instanceId]
  )
    throw new Error("Local candidate is not ready");
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
    throw new Error("Local membership snapshot is incomplete");
  const retained = members.filter((row) => {
    if (
      row.role === "retired" ||
      row.readiness.expiresAt <= now ||
      row.protection.expiresAt <= now
    )
      return false;
    if (
      row.readiness.runtimeMode === candidate.readiness.runtimeMode ||
      row.readiness.runtimeMode === "all" ||
      candidate.readiness.runtimeMode === "all"
    )
      throw new Error(
        "Fresh local owner is still active; stop it and wait for its readiness proof to expire",
      );
    if (
      row.role !== "serving" ||
      row.authorizedGeneration !== control.servingGeneration ||
      !ready(row, input)
    )
      throw new Error("Untargeted local member is not ready");
    return true;
  });
  const nextControl = controlRecordSchema.parse({
    ...control,
    coordinatorToken: candidate.identity.localId,
    coordinatorEpoch: control.coordinatorEpoch + 1,
    coordinatorExpiresAt: now + 900,
    servingGeneration: control.servingGeneration + 1,
    servingMembers: Object.fromEntries(
      [candidate, ...retained].map((row) => [
        row.identity.instanceId,
        row.identity,
      ]),
    ),
  });
  const authorized = [candidate, ...retained].map((row) => ({
    ...row,
    role: "serving" as const,
    authorizedGeneration: nextControl.servingGeneration,
    readiness: {
      ...row.readiness,
      observedEpoch: nextControl.coordinatorEpoch,
      observedGeneration: nextControl.servingGeneration,
    },
  }));
  return { control: nextControl, authorized };
}
