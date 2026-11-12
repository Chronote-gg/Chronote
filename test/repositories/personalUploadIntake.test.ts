/** @jest-environment node */
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import { getPersonalRecordingSegmentRepository } from "../../src/repositories/personalRecordingSegmentRepository";
import { getMockStore } from "../../src/repositories/mockStore";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../../src/types/db";
import { personalMediaClaimForJob } from "../../src/db";

const job: PersonalMediaUploadJobRecord = {
  uploadId: "upload",
  ownerUserId: "owner",
  status: "queued",
  mediaKind: "audio",
  sourceS3Key: "source",
  contentType: "audio/wav",
  fileSize: 100,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(100_000);
  const store = getMockStore();
  store.personalMediaUploadsById.clear();
  store.deploymentControlRecords.clear();
});
afterEach(() => jest.restoreAllMocks());
test("mock signed segment intake preserves the same pending-job and observed-state conditions", async () => {
  const uploads = getPersonalMediaUploadRepository();
  const segments = getPersonalRecordingSegmentRepository();
  const segment: PersonalRecordingSegmentRecord = {
    uploadId: "mock-intake",
    ownerUserId: job.ownerUserId,
    segmentKey: "source#0",
    sourceId: "source",
    sequence: 0,
    kind: "owner_mic",
    label: "Synthetic",
    sourceS3Key: "synthetic-source",
    contentType: "audio/wav",
    fileSize: 10,
    checksumSha256: "a".repeat(64),
    durationMillis: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.100Z",
    status: "pending_upload",
    createdAt: "now",
    updatedAt: "now",
  };
  await uploads.write({
    ...job,
    uploadId: segment.uploadId,
    status: "pending_upload",
  });
  expect(await segments.prepare(segment, undefined)).toBe(true);
  expect(await segments.prepare(segment, undefined)).toBe(false);
  expect(await segments.prepare(segment, "pending_upload")).toBe(true);
  getMockStore()
    .personalRecordingSegmentsByUploadId.get(segment.uploadId)!
    .set(segment.segmentKey, { ...segment, status: "processing" });
  expect(await segments.prepare(segment, "pending_upload")).toBe(false);
  getMockStore()
    .personalRecordingSegmentsByUploadId.get(segment.uploadId)!
    .set(segment.segmentKey, segment);
  getMockStore().personalMediaUploadsById.set(segment.uploadId, {
    ...job,
    uploadId: segment.uploadId,
    status: "processing",
    attempts: 2,
    processingClaimId: "held-claim",
  });
  expect(await segments.prepare(segment, "pending_upload")).toBe(false);
  expect(await uploads.get(segment.uploadId)).toMatchObject({
    status: "processing",
    attempts: 2,
    processingClaimId: "held-claim",
  });
});

test("a delayed duplicate intake cannot reset a processing claim", async () => {
  const repository = getPersonalMediaUploadRepository();
  await repository.write({
    ...job,
    status: "processing",
    attempts: 2,
    processingOwnerInstanceId: "old",
    claimExpiresAt: 160,
  });
  expect(await repository.submit({ ...job })).toBe(false);
  expect(await repository.get(job.uploadId)).toMatchObject({
    status: "processing",
    attempts: 2,
    processingOwnerInstanceId: "old",
  });
});

const claimOptions = (
  claimId: string,
  expectedAttempts = 0,
  nowEpochSeconds = 100,
) => ({
  uploadId: job.uploadId,
  instanceId: "old",
  nowEpochSeconds,
  claimExpiresAt: nowEpochSeconds + 20,
  updatedAt: "now",
  maxAttempts: 3,
  claimId,
  expectedAttempts,
});
test("retry artifacts are bounded, preserve prior keys, and fence stale canonical writes", async () => {
  const repository = getPersonalMediaUploadRepository();
  await repository.write(job);
  const first = await repository.claim(claimOptions("first"));
  expect(first).toBeDefined();
  const oldClaim = personalMediaClaimForJob(first!, "old");
  const history = {
    guildId: "personal:owner",
    channelId_timestamp: "personal#time",
    meetingId: job.uploadId,
    channelId: "personal",
    timestamp: job.createdAt,
    participants: [],
    duration: 0,
    transcribeMeeting: true,
    generateNotes: true,
    ownershipScope: "personal" as const,
    ownerUserId: job.ownerUserId,
    status: "processing" as const,
  };
  expect(await repository.writeHistory(history, oldClaim)).toMatchObject({
    kind: "committed",
    history,
  });
  getMockStore().meetingHistoryByGuild.get(history.guildId)![0].archivedAt =
    "2026-01-01T00:01:00Z";
  expect(
    await repository.writeHistory(
      { ...history, archivedAt: undefined },
      oldClaim,
    ),
  ).toMatchObject({
    kind: "committed",
    history: { ...history, archivedAt: "2026-01-01T00:01:00Z" },
  });
  expect(
    getMockStore().meetingHistoryByGuild.get(history.guildId)![0].archivedAt,
  ).toBe("2026-01-01T00:01:00Z");
  const second = await repository.claim(claimOptions("second", 1, 121));
  expect(second?.artifactAttempts).toMatchObject({
    "1": { prefix: "personal/owner/upload/attempt-1/" },
    "2": { prefix: "personal/owner/upload/attempt-2/" },
  });
  expect(
    await repository.writeHistory(
      { ...history, status: "complete", notes: "stale synthetic output" },
      oldClaim,
    ),
  ).toEqual({ kind: "stale" });
  expect(
    await repository.renewClaim({
      ...oldClaim,
      nowEpochSeconds: 121,
      claimExpiresAt: 170,
      updatedAt: "now",
    }),
  ).toBe(false);
  expect(await repository.submit({ ...job, status: "queued" })).toBe(false);
  expect(await repository.claim(claimOptions("third", 2, 142))).toMatchObject({
    attempts: 3,
  });
  expect(
    await repository.claim(claimOptions("fourth", 3, 163)),
  ).toBeUndefined();
});
