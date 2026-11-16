/** @jest-environment node */
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { getDeploymentControlRepository } from "../../src/db";
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import { getPersonalRecordingSegmentRepository } from "../../src/repositories/personalRecordingSegmentRepository";
import { getMockStore } from "../../src/repositories/mockStore";
import {
  requireUnpausedDesktopDraft,
  getPausedDesktopDraft,
} from "../../src/repositories/pausedDesktopDraft";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";

const job: PersonalMediaUploadJobRecord = {
  uploadId: "synthetic-paused",
  ownerUserId: "synthetic-owner",
  status: "pending_upload",
  mediaKind: "audio",
  sourceS3Key: "source",
  contentType: "audio/wav",
  fileSize: 10,
  createdAt: "now",
  updatedAt: "now",
};
const marker = buildPausedDesktopDraftMarker(job);

beforeEach(() => {
  const store = getMockStore();
  store.personalMediaUploadsById.set(job.uploadId, structuredClone(job));
  store.deploymentControlRecords.clear();
  store.deploymentControlRecords.set(
    JSON.stringify([marker.pk, marker.sk]),
    structuredClone(marker),
  );
});
test("shared lookup exposes structured pause and refuses foreign or invalid bindings", async () => {
  const repository = getDeploymentControlRepository();
  expect(await getPausedDesktopDraft(repository, job)).toEqual(marker);
  await expect(
    requireUnpausedDesktopDraft(repository, job),
  ).rejects.toMatchObject({ code: "paused" });
  await expect(
    getPausedDesktopDraft(repository, { ...job, ownerUserId: "other" }),
  ).rejects.toThrow();
  getMockStore().deploymentControlRecords.set(
    JSON.stringify([marker.pk, marker.sk]),
    { ...marker, pk: "UPLOAD#other" },
  );
  await expect(getPausedDesktopDraft(repository, job)).rejects.toThrow();
  await expect(
    getPausedDesktopDraft(
      {
        getRecord: async () => {
          throw new Error("unavailable");
        },
      },
      job,
    ),
  ).rejects.toThrow("unavailable");
});
test("mock submission and all claim paths refuse key existence", async () => {
  const repository = getPersonalMediaUploadRepository();
  expect(await repository.submit({ ...job, status: "queued" })).toBe(false);
  for (const state of [
    { status: "queued" as const },
    {
      status: "processing" as const,
      processingClaimId: "claim",
      processingOwnerInstanceId: "old",
      claimExpiresAt: 160,
      attempts: 1,
    },
    {
      status: "processing" as const,
      processingClaimId: "expired",
      processingOwnerInstanceId: "old",
      claimExpiresAt: 99,
      attempts: 1,
    },
  ]) {
    getMockStore().personalMediaUploadsById.set(job.uploadId, {
      ...job,
      ...state,
    });
    expect(
      await repository.claim({
        uploadId: job.uploadId,
        instanceId: "old",
        nowEpochSeconds: 100,
        claimExpiresAt: 160,
        updatedAt: "later",
        maxAttempts: 3,
        claimId: "claim",
        expectedAttempts: state.attempts ?? 0,
      }),
    ).toBeUndefined();
  }
  getMockStore().deploymentControlRecords.delete(
    JSON.stringify([marker.pk, marker.sk]),
  );
  getMockStore().personalMediaUploadsById.set(job.uploadId, job);
  expect(await repository.submit({ ...job, status: "queued" })).toBe(true);
});
test("mock late segment prepare and transition refuse key existence", async () => {
  const segment = {
    uploadId: job.uploadId,
    ownerUserId: job.ownerUserId,
    segmentKey: "source#0",
    sourceId: "source",
    sequence: 0,
    kind: "owner_mic" as const,
    label: "Synthetic",
    sourceS3Key: "source",
    contentType: "audio/wav",
    fileSize: 10,
    checksumSha256: "a".repeat(64),
    durationMillis: 100,
    startedAt: "now",
    endedAt: "later",
    status: "pending_upload" as const,
    createdAt: "now",
    updatedAt: "now",
  };
  const repository = getPersonalRecordingSegmentRepository();
  getMockStore().personalRecordingSegmentsByUploadId.set(
    job.uploadId,
    new Map([[segment.segmentKey, segment]]),
  );
  expect(await repository.prepare(segment, "pending_upload")).toBe(false);
  expect(
    await repository.transition(
      { ...segment, status: "uploaded" },
      "pending_upload",
    ),
  ).toBe(false);
});
