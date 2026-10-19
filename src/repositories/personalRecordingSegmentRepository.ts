import type { AdmissionContext } from "../types/deploymentControl";
import { assertMockPersonalAdmission } from "./personalMediaUploadRepository";
import { config } from "../services/configService";
import {
  getPersonalRecordingSegment,
  listPersonalRecordingSegments,
  transitionPersonalRecordingSegment,
  preparePersonalRecordingSegment,
} from "../db";
import type { PersonalRecordingSegmentRecord } from "../types/db";
import { getMockStore } from "./mockStore";

export type PersonalRecordingSegmentRepository = {
  prepare: (
    segment: PersonalRecordingSegmentRecord,
    expectedStatus: "pending_upload" | "failed" | undefined,
    context: AdmissionContext,
  ) => Promise<boolean>;
  transition: (
    segment: PersonalRecordingSegmentRecord,
    expectedStatus: PersonalRecordingSegmentRecord["status"],
    context: AdmissionContext,
  ) => Promise<boolean>;
  get: (
    uploadId: string,
    segmentKey: string,
  ) => Promise<PersonalRecordingSegmentRecord | undefined>;
  listByUpload: (uploadId: string) => Promise<PersonalRecordingSegmentRecord[]>;
};

const realRepository: PersonalRecordingSegmentRepository = {
  prepare: preparePersonalRecordingSegment,
  transition: transitionPersonalRecordingSegment,
  get: getPersonalRecordingSegment,
  listByUpload: listPersonalRecordingSegments,
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
  async prepare(segment, expectedStatus, context) {
    assertMockPersonalAdmission(context);
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
  async transition(segment, expectedStatus, context) {
    assertMockPersonalAdmission(context);
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
};

export function getPersonalRecordingSegmentRepository(): PersonalRecordingSegmentRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
