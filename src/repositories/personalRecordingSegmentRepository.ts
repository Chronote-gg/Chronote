import { config } from "../services/configService";
import {
  getPersonalRecordingSegment,
  listPersonalRecordingSegments,
  updatePersonalRecordingSegment,
  writePersonalRecordingSegment,
} from "../db";
import type { PersonalRecordingSegmentRecord } from "../types/db";
import { getMockStore } from "./mockStore";

export type PersonalRecordingSegmentRepository = {
  write: (segment: PersonalRecordingSegmentRecord) => Promise<void>;
  get: (
    uploadId: string,
    segmentKey: string,
  ) => Promise<PersonalRecordingSegmentRecord | undefined>;
  listByUpload: (uploadId: string) => Promise<PersonalRecordingSegmentRecord[]>;
  update: (segment: PersonalRecordingSegmentRecord) => Promise<void>;
};

const realRepository: PersonalRecordingSegmentRepository = {
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
