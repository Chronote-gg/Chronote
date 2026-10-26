/** @jest-environment node */
import { buildPausedDesktopDraftMarker } from "../../testSupport/personalMediaUploadFixtures";
import crypto from "node:crypto";
import * as db from "../../db";
import { getMockStore, resetMockStore } from "../../repositories/mockStore";
import { getPersonalMediaUploadRepository } from "../../repositories/personalMediaUploadRepository";
import { getPersonalRecordingSegmentRepository } from "../../repositories/personalRecordingSegmentRepository";
import { config } from "../configService";
import type { PausedDesktopDraftRecord } from "../../types/deploymentControl";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../types/db";
import {
  getPersonalMediaUploadJobForUser,
  createPersonalMediaUploadIntent,
  createPersonalRecordingSegmentUploadIntent,
  markPersonalMediaUploadComplete,
  markPersonalRecordingSegmentUploadComplete,
  submitPersonalRecordingUpload,
} from "../personalMediaUploadService";
import {
  getSignedUploadPost,
  getStoredObjectMetadata,
} from "../storageService";

jest.mock("../storageService", () => ({
  getSignedUploadPost: jest.fn(),
  getStoredObjectMetadata: jest.fn(),
}));
const owner = {
  uploadId: "550e8400-e29b-41d4-a716-446655440000",
  userId: "synthetic-owner",
};
const pauseMessage =
  "This draft is preserved and paused. Recovery is not available yet.";
const job = (
  status: PersonalMediaUploadJobRecord["status"] = "pending_upload",
): PersonalMediaUploadJobRecord => ({
  uploadId: owner.uploadId,
  ownerUserId: owner.userId,
  status,
  mediaKind: "audio",
  uploadOrigin: "desktop_recording",
  sourceManifest: [{ sourceId: "mic", kind: "owner_mic", label: "Me" }],
  sourceS3Key: "synthetic/source/",
  contentType: "audio/wav",
  fileSize: 10,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const input = {
  ...owner,
  sourceId: "mic",
  sequence: 0,
  contentType: "audio/wav",
  fileSize: 10,
  checksumSha256: "a".repeat(64),
  durationMillis: 1000,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
};
const segment = (
  status: PersonalRecordingSegmentRecord["status"],
): PersonalRecordingSegmentRecord => ({
  ...input,
  ownerUserId: owner.userId,
  segmentKey: "mic#000000",
  kind: "owner_mic",
  label: "Me",
  sourceS3Key: "synthetic/segment.wav",
  status,
  createdAt: input.startedAt,
  updatedAt: input.endedAt,
});
function pause(overrides: Partial<PausedDesktopDraftRecord> = {}) {
  const record = buildPausedDesktopDraftMarker(
    { uploadId: owner.uploadId, ownerUserId: owner.userId },
    { operationId: "private-operation", ...overrides },
  );
  getMockStore().deploymentControlRecords.set(
    JSON.stringify([record.pk, record.sk]),
    record,
  );
}
function setPauseControlScenario(scenario: string) {
  pause(
    scenario === "owner mismatch"
      ? { ownerUserId: "other" }
      : scenario === "malformed"
        ? { manifestSha256: "bad" }
        : {},
  );
  if (scenario === "unavailable") {
    const repository = db.getDeploymentControlRepository();
    jest
      .spyOn(repository, "getRecord")
      .mockRejectedValue(new Error("unavailable"));
    jest
      .spyOn(db, "getDeploymentControlRepository")
      .mockReturnValue(repository);
  }
}
function putJob(value = job()) {
  getMockStore().personalMediaUploadsById.set(value.uploadId, value);
  return value;
}
function putSegment(value: PersonalRecordingSegmentRecord) {
  getMockStore().personalRecordingSegmentsByUploadId.set(
    owner.uploadId,
    new Map([[value.segmentKey, value]]),
  );
}
const pausedError = { code: "paused", message: pauseMessage };
async function expectPausedSegmentCompletion(
  intent: Awaited<
    ReturnType<typeof createPersonalRecordingSegmentUploadIntent>
  >,
) {
  await expect(
    markPersonalRecordingSegmentUploadComplete({
      ...owner,
      sourceId: "mic",
      sequence: 0,
      key: intent.segment.sourceS3Key,
      uploadToken: intent.uploadToken!,
    }),
  ).rejects.toMatchObject(pausedError);
}

beforeEach(() => {
  resetMockStore();
  config.mock.enabled = true;
  jest
    .mocked(getSignedUploadPost)
    .mockResolvedValue({ url: "https://synthetic.invalid", fields: {} });
  jest.mocked(getStoredObjectMetadata).mockResolvedValue({ contentLength: 10 });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test.each(["pending_upload", "queued", "complete"] as const)(
  "owner sees paused response without changing persisted %s",
  async (status) => {
    const original = putJob(job(status));
    pause();
    const response = await getPersonalMediaUploadJobForUser(owner);
    expect(response).toEqual({
      ...original,
      status: "paused",
      retryable: false,
      errorMessage: pauseMessage,
    });
    expect(JSON.stringify(response)).not.toContain("private-operation");
    expect(getMockStore().personalMediaUploadsById.get(owner.uploadId)).toEqual(
      original,
    );
  },
);
test("wrong owner refuses before any marker lookup", async () => {
  putJob();
  pause();
  const repository = db.getDeploymentControlRepository();
  const lookup = jest.spyOn(repository, "getRecord");
  jest.spyOn(db, "getDeploymentControlRepository").mockReturnValue(repository);
  await expect(
    getPersonalMediaUploadJobForUser({ ...owner, userId: "other" }),
  ).rejects.toMatchObject({ code: "forbidden", message: "Upload not found." });
  expect(lookup).not.toHaveBeenCalled();
});
test.each(["owner mismatch", "malformed", "unavailable"])(
  "status and mutation refuse %s control state",
  async (scenario) => {
    putJob();
    setPauseControlScenario(scenario);
    await expect(getPersonalMediaUploadJobForUser(owner)).rejects.toThrow();
    await expect(submitPersonalRecordingUpload(owner)).rejects.toThrow();
    expect(getSignedUploadPost).not.toHaveBeenCalled();
    expect(getStoredObjectMetadata).not.toHaveBeenCalled();
  },
);
test.each([
  "pending_upload",
  "failed",
  "uploaded",
  "submitted",
  "processed",
] as const)(
  "paused segment %s refuses intent and completion before effects",
  async (status) => {
    const original = putJob();
    const originalSegment = segment(status);
    putSegment(originalSegment);
    pause();
    const tokenSigner = jest.spyOn(crypto, "createHmac");
    await expect(
      createPersonalRecordingSegmentUploadIntent(input),
    ).rejects.toMatchObject(pausedError);
    await expect(
      markPersonalRecordingSegmentUploadComplete({
        ...owner,
        sourceId: "mic",
        sequence: 0,
        key: originalSegment.sourceS3Key,
        uploadToken: "irrelevant",
      }),
    ).rejects.toMatchObject(pausedError);
    expect(getSignedUploadPost).not.toHaveBeenCalled();
    expect(getStoredObjectMetadata).not.toHaveBeenCalled();
    expect(tokenSigner).not.toHaveBeenCalled();
    expect(getMockStore().personalMediaUploadsById.get(owner.uploadId)).toEqual(
      original,
    );
    expect(
      await getPersonalRecordingSegmentRepository().get(
        owner.uploadId,
        originalSegment.segmentKey,
      ),
    ).toEqual(originalSegment);
  },
);
test.each(["pending_upload", "queued", "complete"] as const)(
  "paused %s refuses ordinary completion and desktop submission shortcuts",
  async (status) => {
    putJob(job(status));
    pause();
    await expect(
      markPersonalMediaUploadComplete({
        ...owner,
        key: "synthetic/source/",
        uploadToken: "irrelevant",
      }),
    ).rejects.toMatchObject(pausedError);
    await expect(submitPersonalRecordingUpload(owner)).rejects.toMatchObject(
      pausedError,
    );
    expect(getStoredObjectMetadata).not.toHaveBeenCalled();
  },
);
test("delayed ordinary HEAD cannot submit a newly paused original", async () => {
  const intent = await createPersonalMediaUploadIntent({
    userId: owner.userId,
    contentType: "audio/wav",
    fileSize: 10,
  });
  const original = getMockStore().personalMediaUploadsById.get(intent.uploadId);
  jest.mocked(getStoredObjectMetadata).mockImplementationOnce(async () => {
    const marker = buildPausedDesktopDraftMarker(
      { uploadId: intent.uploadId, ownerUserId: owner.userId },
      { operationId: "synthetic" },
    );
    getMockStore().deploymentControlRecords.set(
      JSON.stringify([marker.pk, marker.sk]),
      marker,
    );
    return { contentLength: 10 };
  });
  await expect(
    markPersonalMediaUploadComplete({
      uploadId: intent.uploadId,
      userId: owner.userId,
      key: intent.key,
      uploadToken: intent.uploadToken,
    }),
  ).rejects.toMatchObject(pausedError);
  expect(getMockStore().personalMediaUploadsById.get(intent.uploadId)).toEqual(
    original,
  );
});
test("delayed segment HEAD cannot complete a newly paused original", async () => {
  putJob();
  const intent = await createPersonalRecordingSegmentUploadIntent(input);
  const original = await getPersonalRecordingSegmentRepository().get(
    owner.uploadId,
    "mic#000000",
  );
  jest.mocked(getStoredObjectMetadata).mockImplementationOnce(async () => {
    pause();
    return { contentLength: 10 };
  });
  await expectPausedSegmentCompletion(intent);
  expect(
    await getPersonalRecordingSegmentRepository().get(
      owner.uploadId,
      "mic#000000",
    ),
  ).toEqual(original);
});
test("concurrent prepared segment cannot return success after pause", async () => {
  putJob();
  jest
    .spyOn(getPersonalRecordingSegmentRepository(), "prepare")
    .mockImplementationOnce(async () => {
      putSegment(segment("uploaded"));
      pause();
      return false;
    });
  await expect(
    createPersonalRecordingSegmentUploadIntent(input),
  ).rejects.toMatchObject(pausedError);
});
test("concurrent submission cannot return success after pause", async () => {
  putJob();
  putSegment(segment("submitted"));
  jest
    .spyOn(getPersonalMediaUploadRepository(), "submit")
    .mockImplementationOnce(async () => {
      putJob(job("queued"));
      pause();
      return false;
    });
  await expect(submitPersonalRecordingUpload(owner)).rejects.toMatchObject(
    pausedError,
  );
});
test("concurrent segment transition cannot hide pause behind a submitted segment", async () => {
  putJob();
  putSegment(segment("uploaded"));
  jest
    .spyOn(getPersonalRecordingSegmentRepository(), "transition")
    .mockImplementationOnce(async () => {
      putSegment(segment("submitted"));
      pause();
      return false;
    });
  await expect(submitPersonalRecordingUpload(owner)).rejects.toMatchObject(
    pausedError,
  );
});
test("ordinary unpaused segment intent, completion and submission still work", async () => {
  putJob();
  const intent = await createPersonalRecordingSegmentUploadIntent(input);
  await expect(
    markPersonalRecordingSegmentUploadComplete({
      ...owner,
      sourceId: "mic",
      sequence: 0,
      key: intent.segment.sourceS3Key,
      uploadToken: intent.uploadToken!,
    }),
  ).resolves.toMatchObject({ status: "uploaded" });
  await expect(submitPersonalRecordingUpload(owner)).resolves.toMatchObject({
    status: "queued",
  });
  await expect(getPersonalMediaUploadJobForUser(owner)).resolves.toMatchObject({
    status: "queued",
  });
});

test("pause during the existing-segment read refuses the early success and signer", async () => {
  putJob();
  putSegment(segment("uploaded"));
  jest
    .spyOn(getPersonalRecordingSegmentRepository(), "get")
    .mockImplementationOnce(async () => {
      pause();
      return segment("uploaded");
    });
  await expect(
    createPersonalRecordingSegmentUploadIntent(input),
  ).rejects.toMatchObject(pausedError);
  expect(getSignedUploadPost).not.toHaveBeenCalled();
});
test("pause during a concurrent completion refuses the returned segment", async () => {
  putJob();
  const intent = await createPersonalRecordingSegmentUploadIntent(input);
  jest
    .spyOn(getPersonalRecordingSegmentRepository(), "transition")
    .mockImplementationOnce(async () => {
      putSegment(segment("uploaded"));
      pause();
      return false;
    });
  await expectPausedSegmentCompletion(intent);
});
test("mock queue excludes paused originals before limiting ordinary jobs", async () => {
  putJob(job("queued"));
  pause();
  const ordinary = {
    ...job("queued"),
    uploadId: "ordinary",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  getMockStore().personalMediaUploadsById.set(ordinary.uploadId, ordinary);
  await expect(
    getPersonalMediaUploadRepository().listClaimable({
      instanceId: "worker",
      nowEpochSeconds: 100,
      maxAttempts: 3,
      limit: 1,
    }),
  ).resolves.toEqual([ordinary]);
});

test.each(["owner mismatch", "malformed", "unavailable"])(
  "mock queue refuses %s control state",
  async (scenario) => {
    putJob(job("queued"));
    setPauseControlScenario(scenario);
    await expect(
      getPersonalMediaUploadRepository().listClaimable({
        instanceId: "worker",
        nowEpochSeconds: 100,
        maxAttempts: 3,
        limit: 1,
      }),
    ).rejects.toThrow();
  },
);

test("pause during concurrent parent read refuses a successful queued raw result", async () => {
  const original = putJob();
  putSegment(segment("submitted"));
  jest
    .spyOn(getPersonalMediaUploadRepository(), "submit")
    .mockResolvedValueOnce(false);
  jest
    .spyOn(getPersonalMediaUploadRepository(), "get")
    .mockResolvedValueOnce(original)
    .mockImplementationOnce(async () => {
      const queued = putJob(job("queued"));
      pause();
      return queued;
    });
  await expect(submitPersonalRecordingUpload(owner)).rejects.toMatchObject(
    pausedError,
  );
});
test("pause during concurrent segment read refuses a successful uploaded result", async () => {
  putJob();
  const intent = await createPersonalRecordingSegmentUploadIntent(input);
  const pending = await getPersonalRecordingSegmentRepository().get(
    owner.uploadId,
    "mic#000000",
  );
  jest
    .spyOn(getPersonalRecordingSegmentRepository(), "transition")
    .mockResolvedValueOnce(false);
  jest
    .spyOn(getPersonalRecordingSegmentRepository(), "get")
    .mockResolvedValueOnce(pending)
    .mockImplementationOnce(async () => {
      const uploaded = segment("uploaded");
      putSegment(uploaded);
      pause();
      return uploaded;
    });
  await expectPausedSegmentCompletion(intent);
});
