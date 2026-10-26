import { config } from "../services/configService";
import {
  getPersonalRecordingSegment,
  listPersonalRecordingSegments,
  updatePersonalRecordingSegment,
  writePersonalRecordingSegment,
  transitionPersonalRecordingSegment,
  preparePersonalRecordingSegment,
} from "../db";
import type { PersonalRecordingSegmentRecord } from "../types/db";
import { getMockStore } from "./mockStore";
import { mockDesktopDraftPaused } from "./pausedDesktopDraft";

export type PersonalRecordingSegmentRepository = {
  prepare: (
    segment: PersonalRecordingSegmentRecord,
    expectedStatus: "pending_upload" | "failed" | undefined,
  ) => Promise<boolean>;
  transition: (
    segment: PersonalRecordingSegmentRecord,
    expectedStatus: PersonalRecordingSegmentRecord["status"],
  ) => Promise<boolean>;
  write: (segment: PersonalRecordingSegmentRecord) => Promise<void>;
  get: (
    uploadId: string,
    segmentKey: string,
  ) => Promise<PersonalRecordingSegmentRecord | undefined>;
  listByUpload: (uploadId: string) => Promise<PersonalRecordingSegmentRecord[]>;
  update: (segment: PersonalRecordingSegmentRecord) => Promise<void>;
};

const realRepository: PersonalRecordingSegmentRepository = {
  prepare: preparePersonalRecordingSegment,
  transition: transitionPersonalRecordingSegment,
  write: writePersonalRecordingSegment,
  get: getPersonalRecordingSegment,
  listByUpload: listPersonalRecordingSegments,
  update: updatePersonalRecordingSegment,
};

const segmentMapForUpload = (uploadId: string) => {
  const store = getMockStore();
  let segments = store.personalRecordingSegmentsByUploadId.get(uploadId);
  if (!segments) {
    segments = new Map<string, PersonalRecordingSegmentRecord>();
    store.personalRecordingSegmentsByUploadId.set(uploadId, segments);
  }
  return segments;
};

const mockRepository: PersonalRecordingSegmentRepository = {
  async prepare(segment, expectedStatus) {
    if (mockDesktopDraftPaused(segment.uploadId)) return false;
    const job = getMockStore().personalMediaUploadsById.get(segment.uploadId);
    const current = segmentMapForUpload(segment.uploadId).get(
      segment.segmentKey,
    );
    if (
      job?.status !== "pending_upload" ||
      job.ownerUserId !== segment.ownerUserId ||
      job.processingClaimId
    )
      return false;
    if (
      expectedStatus
        ? current?.status !== expectedStatus ||
          current.ownerUserId !== segment.ownerUserId
        : Boolean(current)
    )
      return false;
    segmentMapForUpload(segment.uploadId).set(
      segment.segmentKey,
      structuredClone(segment),
    );
    return true;
  },
  async transition(segment, expectedStatus) {
    if (mockDesktopDraftPaused(segment.uploadId)) return false;
    const current = segmentMapForUpload(segment.uploadId).get(
      segment.segmentKey,
    );
    if (
      current?.status !== expectedStatus ||
      current.ownerUserId !== segment.ownerUserId
    )
      return false;
    segmentMapForUpload(segment.uploadId).set(
      segment.segmentKey,
      structuredClone(segment),
    );
    return true;
  },
  async write(segment) {
    segmentMapForUpload(segment.uploadId).set(segment.segmentKey, segment);
  },
  async get(uploadId, segmentKey) {
    return getMockStore()
      .personalRecordingSegmentsByUploadId.get(uploadId)
      ?.get(segmentKey);
  },
  async listByUpload(uploadId) {
    return [
      ...(getMockStore()
        .personalRecordingSegmentsByUploadId.get(uploadId)
        ?.values() ?? []),
    ].sort((left, right) => left.segmentKey.localeCompare(right.segmentKey));
  },
  async update(segment) {
    segmentMapForUpload(segment.uploadId).set(segment.segmentKey, segment);
  },
};

export function getPersonalRecordingSegmentRepository(): PersonalRecordingSegmentRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
