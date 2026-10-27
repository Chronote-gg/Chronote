import assert from "node:assert/strict";
import { getMockStore } from "../../src/repositories/mockStore";
import { getDeploymentControlRepository } from "../../src/db";
import {
  createRuntimeLifecycle,
  installRuntimeLifecycle,
  type RuntimeLifecycle,
} from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";

let lifecycle: RuntimeLifecycle | undefined;
const records = getMockStore().deploymentControlRecords;
const identity = {
  kind: "local" as const,
  instanceId: getRuntimeInstanceId(),
  localId: "admitted-test-runtime",
  protocolVersion: 1 as const,
};

/** Exercise real runtime, promotion and repository admission with local mock storage. */
export async function seedServingRuntime() {
  records.clear();
  getMockStore().deploymentControlRecords = records;
  const repository = getDeploymentControlRepository();
  const now = Math.floor(Date.now() / 1000);
  await repository.initializeControl({
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "local",
    protocolVersion: 1,
    coordinatorToken: "fixture",
    coordinatorEpoch: 1,
    coordinatorExpiresAt: now + 900,
    servingGeneration: 0,
    servingMembers: {},
  });
  if (!lifecycle) {
    lifecycle = createRuntimeLifecycle({
      identity,
      repository,
      protection: createRuntimeProtectionService({
        identity,
        onUnsafe: () => {},
      }),
      probeReadiness: async () => ({
        gatewayReady: true,
        cacheReady: true,
        dependenciesReady: true,
      }),
      checkpointAndFence: async () => {},
    });
    installRuntimeLifecycle(lifecycle);
    await lifecycle.start();
  } else await lifecycle.refreshRuntimeReadiness();
  const promoted = await repository.promote({
    candidateRuntimeMode: "all",
    coordinatorToken: "fixture",
    coordinatorEpoch: 1,
    expectedServingGeneration: 0,
    expectedServingMembers: [],
    candidate: identity,
    proposedGeneration: 1,
    now: Math.floor(Date.now() / 1000),
  });
  assert.equal(promoted, "applied");
  const context = await lifecycle.getRuntimeAdmissionContext();
  assert.equal((await repository.checkAdmission(context)).kind, "admitted");
  return lifecycle;
}
export const stopServingRuntime = () => lifecycle?.stop();
