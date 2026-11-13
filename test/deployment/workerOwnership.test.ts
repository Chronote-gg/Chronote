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
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import {
  processPersonalMediaUploadJob,
  stopPersonalMediaUploadWorker,
} from "../../src/services/personalMediaUploadWorkerService";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "../../src/services/personalMediaUploadProcessingService";
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

test("claimed work renews after polling stops and aborts its run once the claim is lost", async () => {
  jest.useFakeTimers({ now: 100_000 });
  const instanceId = getRuntimeInstanceId();
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
  const providerGate = barrier();
  const providerStarted = barrier();
  let runSignal: AbortSignal | undefined;
  jest
    .mocked(createPersonalMediaProcessingMeeting)
    .mockImplementation(async (claimed) => claimed);
  jest
    .mocked(processPersonalMediaUpload)
    .mockImplementation(async (_job, _instance, signal) => {
      runSignal = signal;
      providerStarted.resolve();
      await providerGate.promise;
      signal?.throwIfAborted();
    });
  try {
    const processing = processPersonalMediaUploadJob(job);
    await providerStarted.promise;
    const before = await uploads.get(job.uploadId);
    stopPersonalMediaUploadWorker();
    await jest.advanceTimersByTimeAsync(
      PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS + 1,
    );
    expect((await uploads.get(job.uploadId))!.claimExpiresAt).toBeGreaterThan(
      before!.claimExpiresAt!,
    );
    expect(runSignal?.aborted).toBe(false);
    jest.spyOn(uploads, "renewClaim").mockResolvedValueOnce(false);
    await jest.advanceTimersByTimeAsync(
      PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS,
    );
    expect(runSignal?.aborted).toBe(true);
    providerGate.resolve();
    await expect(processing).resolves.toBeUndefined();
    expect(await uploads.get(job.uploadId)).toMatchObject({
      status: "processing",
      processingOwnerInstanceId: instanceId,
      attempts: 1,
    });
  } finally {
    providerGate.resolve();
    jest.restoreAllMocks();
    jest.useRealTimers();
  }
});
