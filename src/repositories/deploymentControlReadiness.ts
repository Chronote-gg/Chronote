import {
  sameRuntimeIdentity,
  type AdmissionContext,
  type ControlRecord,
  type RuntimeRecord,
} from "../types/deploymentControl";

export function proofReady(
  row: RuntimeRecord,
  epoch: number | undefined,
  generation: number,
  now: number,
): boolean {
  return (
    (epoch === undefined || row.readiness.observedEpoch === epoch) &&
    row.readiness.observedGeneration === generation &&
    (row.readiness.runtimeMode === "api" || row.readiness.gatewayReady) &&
    row.readiness.cacheReady &&
    row.readiness.dependenciesReady &&
    row.readiness.provenAt <= now &&
    row.readiness.expiresAt > now &&
    row.protection.provenAt <= now &&
    row.protection.expiresAt > now &&
    row.expiresAt === undefined
  );
}

export function mockServingAdmissionAllowed(
  control: ControlRecord,
  row: RuntimeRecord,
  context: AdmissionContext,
) {
  const selected = control.servingMembers[context.instanceId];
  return Boolean(
    selected &&
    sameRuntimeIdentity(selected, context.identity) &&
    sameRuntimeIdentity(row.identity, context.identity) &&
    control.servingGeneration === context.authorizedGeneration &&
    row.role === "serving" &&
    row.authorizedGeneration === context.authorizedGeneration &&
    proofReady(row, undefined, context.authorizedGeneration, context.now),
  );
}
