import type { PausedDesktopDraftRecord } from "../types/deploymentControl";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../types/db";

export const buildJob = (): PersonalMediaUploadJobRecord => ({
  uploadId: "upload-1",
  ownerUserId: "user-1",
  status: "queued",
  attempts: 1,
  processingClaimId: "synthetic-claim",
  processingOwnerInstanceId: "instance-1",
  claimExpiresAt: 2_000_000_000,
  artifactAttempts: Object.fromEntries(
    [1, 2, 3].map((attempt) => {
      const prefix = `personal/user-1/upload-1/attempt-${attempt}/`;
      return [
        String(attempt),
        {
          prefix,
          audioS3Key: `${prefix}audio.mp3`,
          transcriptS3Key: `${prefix}transcript.json`,
        },
      ];
    }),
  ),
  mediaKind: "audio",
  sourceS3Key: "personal-media-uploads/user-1/upload-1/source.mp3",
  contentType: "audio/mpeg",
  fileSize: 1234,
  createdAt: "2026-01-06T18:00:00.000Z",
  updatedAt: "2026-01-06T18:00:00.000Z",
});

export const buildDesktopJob = (): PersonalMediaUploadJobRecord => ({
  ...buildJob(),
  uploadOrigin: "desktop_recording",
  sourceS3Key: "personal-media-uploads/user-1/upload-1/segments/",
  sourceManifest: [{ sourceId: "owner_mic", kind: "owner_mic", label: "Me" }],
  contentType: "audio/wav",
  fileSize: 2000,
  status: "processing",
  processingOwnerInstanceId: "instance-1",
});

export const buildSegment = (
  sequence: number,
  status: PersonalRecordingSegmentRecord["status"] = "submitted",
): PersonalRecordingSegmentRecord => ({
  uploadId: "upload-1",
  segmentKey: `owner_mic#${String(sequence).padStart(6, "0")}`,
  ownerUserId: "user-1",
  sourceId: "owner_mic",
  sequence,
  kind: "owner_mic",
  label: "Me",
  sourceS3Key: `personal-media-uploads/user-1/upload-1/segments/owner_mic-${String(sequence).padStart(6, "0")}.wav`,
  contentType: "audio/wav",
  fileSize: 1000,
  checksumSha256: "a".repeat(64),
  durationMillis: 1000,
  startedAt: `2026-01-06T18:00:0${sequence}.000Z`,
  endedAt: `2026-01-06T18:00:0${sequence + 1}.000Z`,
  status,
  createdAt: "2026-01-06T18:00:00.000Z",
  updatedAt: "2026-01-06T18:00:00.000Z",
});

export const buildPausedDesktopDraftMarker = (
  job: Pick<PersonalMediaUploadJobRecord, "uploadId" | "ownerUserId">,
  overrides: Partial<PausedDesktopDraftRecord> = {},
): PausedDesktopDraftRecord => ({
  pk: `UPLOAD#${job.uploadId}`,
  sk: "PAUSED_DRAFT",
  recordType: "paused_desktop_draft",
  protocolVersion: 1,
  uploadId: job.uploadId,
  ownerUserId: job.ownerUserId,
  operationId: "synthetic-operation",
  manifestSha256: "a".repeat(64),
  preservedCaptureSha256: "b".repeat(64),
  createdAt: 100,
  ...overrides,
});

export function heldOperation() {
  let release!: () => void;
  let enter!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    wait: async () => {
      enter();
      await waiting;
    },
  };
}
