/** @jest-environment node */
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/services/configService", () => {
  Object.assign(process.env, {
    MOCK_MODE: "true",
    ENABLE_OAUTH: "false",
    ENABLE_MCP: "false",
    DISCORD_BOT_TOKEN: "r3-synthetic",
    DISCORD_CLIENT_ID: "r3-synthetic",
    OPENAI_API_KEY: "r3-synthetic",
    SESSION_SECRET: "r3-synthetic",
    OAUTH_SECRET: "r3-synthetic",
    FRONTEND_SITE_URL: "http://localhost",
    LANGFUSE_PUBLIC_KEY: "",
    LANGFUSE_SECRET_KEY: "",
    LANGFUSE_TRACING_ENABLED: "false",
    POSTHOG_KEY: "",
    STRIPE_SECRET_KEY: "",
    NOTION_CLIENT_SECRET: "",
    STORAGE_ACCESS_KEY_ID: "",
    STORAGE_SECRET_ACCESS_KEY: "",
    REDIS_URL: "",
    CACHE_REDIS_URL: "",
    ECS_CONTAINER_METADATA_URI_V4: "",
    ECS_AGENT_URI: "",
    AWS_EXECUTION_ENV: "",
    AWS_EC2_METADATA_DISABLED: "true",
  });
  return jest.requireActual("../../src/services/configService");
});
import { getDeploymentControlRepository } from "../../src/db";
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import {
  createRuntimeLifecycle,
  installRuntimeLifecycle,
} from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import {
  processPersonalMediaUploadJob,
  stopPersonalMediaUploadWorker,
} from "../../src/services/personalMediaUploadWorkerService";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "../../src/services/personalMediaUploadProcessingService";
import {
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
import { PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS } from "../../src/constants";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";

jest.mock("../../src/services/personalMediaUploadProcessingService", () => ({
  createPersonalMediaProcessingMeeting: jest.fn(),
  processPersonalMediaUpload: jest.fn(),
}));
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("pending claims count synchronously and claimed work renews after polling stops, then retains fenced uncertainty", async () => {
  jest.useFakeTimers({ now: 100_000 });
  const instanceId = getRuntimeInstanceId();
  const identity = {
    kind: "local" as const,
    instanceId,
    localId: "synthetic-worker",
    protocolVersion: 1 as const,
  };
  const repository = getDeploymentControlRepository();
  await repository.initializeControl({
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "local",
    protocolVersion: 1,
    coordinatorToken: "fixture",
    coordinatorEpoch: 1,
    coordinatorExpiresAt: 1000,
    servingGeneration: 0,
    servingMembers: {},
  });
  const protection = createRuntimeProtectionService({
    identity,
    onUnsafe: jest.fn(),
  });
  const lifecycle = createRuntimeLifecycle({
    identity,
    repository,
    protection,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  installRuntimeLifecycle(lifecycle);
  await lifecycle.start();
  await repository.promote({
    candidateRuntimeMode: "all",
    coordinatorToken: "fixture",
    coordinatorEpoch: 1,
    expectedServingGeneration: 0,
    expectedServingMembers: [],
    candidate: identity,
    proposedGeneration: 1,
    now: 100,
  });
  await lifecycle.getRuntimeAdmissionContext();
  const uploads = getPersonalMediaUploadRepository();
  const job: PersonalMediaUploadJobRecord = {
    uploadId: "held-upload",
    ownerUserId: "synthetic-owner",
    status: "queued",
    mediaKind: "audio",
    sourceS3Key: "synthetic-source",
    contentType: "audio/wav",
    fileSize: 10,
    createdAt: "now",
    updatedAt: "now",
  };
  await uploads.write(job);
  const claimGate = barrier();
  const providerGate = barrier();
  const providerStarted = barrier();
  const originalClaim = uploads.claim;
  jest.spyOn(uploads, "claim").mockImplementationOnce(async (input) => {
    await claimGate.promise;
    return originalClaim(input);
  });
  jest
    .mocked(createPersonalMediaProcessingMeeting)
    .mockImplementation(async (claimed) => claimed);
  jest
    .mocked(processPersonalMediaUpload)
    .mockImplementation(async (_job, _instance, signal) => {
      providerStarted.resolve();
      await providerGate.promise;
      signal?.throwIfAborted();
    });
  const processing = processPersonalMediaUploadJob(job);
  expect(lifecycle.getWorkCounts().pending_admission).toBe(1);
  await Promise.resolve();
  expect(getRuntimeWorkAdmissionCheckpoints()).toMatchObject([
    { id: job.uploadId, stage: "pending", ownedPromise: processing },
  ]);
  claimGate.resolve();
  await providerStarted.promise;
  expect(lifecycle.getWorkCounts()).toMatchObject({
    pending_admission: 0,
    personal_processing: 1,
  });
  const before = await uploads.get(job.uploadId);
  lifecycle.closeAdmission();
  stopPersonalMediaUploadWorker();
  await jest.advanceTimersByTimeAsync(
    PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS + 1,
  );
  expect((await uploads.get(job.uploadId))!.claimExpiresAt).toBeGreaterThan(
    before!.claimExpiresAt!,
  );
  const renewalGate = barrier();
  const renewalStarted = barrier();
  const renew = uploads.renewClaim.bind(uploads);
  jest.spyOn(uploads, "renewClaim").mockImplementationOnce(async (input) => {
    renewalStarted.resolve();
    await renewalGate.promise;
    return renew(input);
  });
  await jest.advanceTimersByTimeAsync(
    PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS,
  );
  await renewalStarted.promise;
  fenceRuntimeWorkAdmissions();
  providerGate.resolve();
  let locallySettled = false;
  void processing.then(() => {
    locallySettled = true;
  });
  await jest.advanceTimersByTimeAsync(0);
  expect(locallySettled).toBe(false);
  expect(getRuntimeWorkAdmissionCheckpoints()[0].localSettled).toBe(false);
  renewalGate.resolve();
  await processing;
  expect(lifecycle.getWorkCounts().personal_processing).toBe(1);
  expect(getRuntimeWorkAdmissionCheckpoints()).toMatchObject([
    {
      id: job.uploadId,
      stage: "unresolved",
      fenced: true,
      localSettled: true,
      ownedPromise: processing,
      signal: expect.objectContaining({ aborted: true }),
      claim: { instanceId, attempt: 1 },
    },
  ]);
  expect((await uploads.get(job.uploadId))?.status).toBe("processing");
  lifecycle.stop();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
