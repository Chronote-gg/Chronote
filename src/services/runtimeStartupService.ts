import { config } from "./configService";
import { createArtifactAdmissionGate } from "./artifactAdmissionGate";
import { createRuntimeArtifactSafety } from "./runtimeArtifactSafety";
import { createRuntimeArtifactStorage } from "./runtimeArtifactStorage";
import { getArtifactSafetyRepository } from "../repositories/artifactSafetyRepository";
import { meetingArtifactProducers } from "./meetingArtifactProducer";
import {
  localArtifactCleanup,
  createLocalArtifactCleanupAuthorization,
} from "./meetingArtifactCleanupService";
import { getTempBaseDir, getRetainedTempBaseDir } from "./tempFileService";
import { getDeploymentControlRepository } from "../db";
import {
  getRuntimeInstanceId,
  resolveRuntimeIdentity,
} from "./runtimeInstanceService";
import { createRuntimeProtectionService } from "./runtimeProtectionService";
import {
  createRuntimeLifecycle,
  installRuntimeLifecycle,
  startRuntimeLifecycle,
} from "./runtimeLifecycleService";
import { isRuntimeCacheReady } from "./cacheService";
import type { RuntimeReadiness } from "../types/deploymentControl";
import {
  bootstrapLocalRuntime,
  initializeLocalControl,
} from "./runtimeLocalBootstrapService";

/** Protection precedes login, application routes and workers; liveness may listen earlier. */
export async function initializeRuntimeLifecycle(
  gatewayReady: () => boolean,
  runtimeMode: RuntimeReadiness["runtimeMode"],
  signal?: AbortSignal,
  checkpointAndFence?: () => Promise<void>,
) {
  if (
    !config.runtime.ecs &&
    !config.mock.enabled &&
    !config.database.useLocalDynamoDB
  )
    throw new Error(
      "Local runtime requires explicit mock or local DynamoDB storage",
    );
  const identity = await resolveRuntimeIdentity(
    config.runtime.ecs
      ? {
          kind: "ecs",
          metadataUri: config.runtime.metadataUri,
          candidateId: config.runtime.candidateId,
        }
      : { kind: "local", localId: getRuntimeInstanceId() },
  );
  signal?.throwIfAborted();
  const repository = getDeploymentControlRepository();
  let dependenciesReady = false;
  const protection = createRuntimeProtectionService({
    identity,
    agentUri: config.runtime.agentUri,
    onUnsafe: () => undefined,
    signal,
  });
  const artifactAdmission = createArtifactAdmissionGate();
  const artifactSafety = createRuntimeArtifactSafety({
    identity,
    admission: artifactAdmission,
    repository: getArtifactSafetyRepository(),
    control: repository,
    isProtected: () => protection.isSafe(),
    signal,
    storage: createRuntimeArtifactStorage({
      roots: { working: getTempBaseDir(), retained: getRetainedTempBaseDir() },
      producers: meetingArtifactProducers,
      cleanup: localArtifactCleanup,
      authorize: createLocalArtifactCleanupAuthorization(),
    }),
  });
  const lifecycle = createRuntimeLifecycle({
    artifactAdmission,
    artifactSafety,
    identity,
    runtimeMode,
    repository,
    protection,
    probeReadiness: async () => ({
      gatewayReady: gatewayReady(),
      cacheReady: await isRuntimeCacheReady(),
      dependenciesReady,
    }),
    checkpointAndFence,
  });
  if (identity.kind === "local")
    await initializeLocalControl(
      repository,
      identity,
      Math.floor(Date.now() / 1000),
    );
  signal?.throwIfAborted();
  installRuntimeLifecycle(lifecycle);
  await startRuntimeLifecycle(identity);
  return {
    async ready() {
      signal?.throwIfAborted();
      await artifactSafety.startupReady();
      dependenciesReady = true;
      await lifecycle.refreshRuntimeReadiness();
      if (identity.kind === "local") {
        await bootstrapLocalRuntime(
          repository,
          identity,
          () => lifecycle.refreshRuntimeReadiness(),
          () => Math.floor(Date.now() / 1000),
        );
        await lifecycle.refreshRuntimeReadiness();
      }
    },
    failed() {
      lifecycle.closeAdmission();
      lifecycle.stop();
    },
  };
}
