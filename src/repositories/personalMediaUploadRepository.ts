import { config } from "../services/configService";
import {
  claimPersonalMediaUploadJob,
  getPersonalMediaUploadJob,
  listClaimablePersonalMediaUploadJobs,
  renewPersonalMediaUploadJobClaim,
  updateClaimedPersonalMediaUploadJobProgress,
  updatePersonalMediaUploadJob,
  writeClaimedPersonalMediaUploadJob,
  writePersonalMediaUploadJob,
} from "../db";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import { getMockStore } from "./mockStore";

export type PersonalMediaUploadRepository = {
  write: (job: PersonalMediaUploadJobRecord) => Promise<void>;
  get: (uploadId: string) => Promise<PersonalMediaUploadJobRecord | undefined>;
  update: (job: PersonalMediaUploadJobRecord) => Promise<void>;
  listClaimable: (options: {
    instanceId: string;
    nowEpochSeconds: number;
    maxAttempts: number;
    limit: number;
  }) => Promise<PersonalMediaUploadJobRecord[]>;
  claim: (options: {
    uploadId: string;
    instanceId: string;
    nowEpochSeconds: number;
    claimExpiresAt: number;
    updatedAt: string;
    maxAttempts: number;
  }) => Promise<PersonalMediaUploadJobRecord | undefined>;
  renewClaim: (options: {
    uploadId: string;
    instanceId: string;
    claimExpiresAt: number;
    updatedAt: string;
  }) => Promise<boolean>;
  updateClaimed: (
    job: PersonalMediaUploadJobRecord,
    instanceId: string,
  ) => Promise<boolean>;
  updateProgress: (options: {
    uploadId: string;
    instanceId: string;
    segmentCount: number;
    uploadedSegmentCount: number;
    processedSegmentCount: number;
    updatedAt: string;
  }) => Promise<boolean>;
};

const realRepository: PersonalMediaUploadRepository = {
  write: writePersonalMediaUploadJob,
  get: getPersonalMediaUploadJob,
  update: updatePersonalMediaUploadJob,
  listClaimable: listClaimablePersonalMediaUploadJobs,
  claim: claimPersonalMediaUploadJob,
  renewClaim: renewPersonalMediaUploadJobClaim,
  updateClaimed: writeClaimedPersonalMediaUploadJob,
  updateProgress: updateClaimedPersonalMediaUploadJobProgress,
};

const mockRepository: PersonalMediaUploadRepository = {
  async write(job) {
    getMockStore().personalMediaUploadsById.set(job.uploadId, job);
  },
  async get(uploadId) {
    return getMockStore().personalMediaUploadsById.get(uploadId);
  },
  async update(job) {
    getMockStore().personalMediaUploadsById.set(job.uploadId, job);
  },
  async listClaimable({ instanceId, nowEpochSeconds, maxAttempts, limit }) {
    return Array.from(getMockStore().personalMediaUploadsById.values())
      .filter(
        (job) =>
          (job.status === "queued" || job.status === "processing") &&
          (job.attempts ?? 0) < maxAttempts &&
          ((job.claimExpiresAt ?? 0) < nowEpochSeconds ||
            job.processingOwnerInstanceId === instanceId),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit);
  },
  async claim({
    uploadId,
    instanceId,
    nowEpochSeconds,
    claimExpiresAt,
    updatedAt,
    maxAttempts,
  }) {
    const job = getMockStore().personalMediaUploadsById.get(uploadId);
    if (!job) return undefined;
    const claimExpired = (job.claimExpiresAt ?? 0) < nowEpochSeconds;
    const attempts = job.attempts ?? 0;
    const claimable =
      attempts < maxAttempts &&
      (job.status === "queued" ||
        (job.status === "processing" && claimExpired));
    if (!claimable) return undefined;
    const next: PersonalMediaUploadJobRecord = {
      ...job,
      status: "processing",
      processingOwnerInstanceId: instanceId,
      claimExpiresAt,
      processingStartedAt: job.processingStartedAt ?? updatedAt,
      attempts: attempts + 1,
      updatedAt,
    };
    getMockStore().personalMediaUploadsById.set(uploadId, next);
    return next;
  },
  async renewClaim({ uploadId, instanceId, claimExpiresAt, updatedAt }) {
    const job = getMockStore().personalMediaUploadsById.get(uploadId);
    if (
      !job ||
      job.status !== "processing" ||
      job.processingOwnerInstanceId !== instanceId
    ) {
      return false;
    }
    getMockStore().personalMediaUploadsById.set(uploadId, {
      ...job,
      claimExpiresAt,
      updatedAt,
    });
    return true;
  },
  async updateClaimed(job, instanceId) {
    const current = getMockStore().personalMediaUploadsById.get(job.uploadId);
    if (
      !current ||
      current.status !== "processing" ||
      current.processingOwnerInstanceId !== instanceId
    ) {
      return false;
    }
    getMockStore().personalMediaUploadsById.set(job.uploadId, job);
    return true;
  },
  async updateProgress({
    uploadId,
    instanceId,
    segmentCount,
    uploadedSegmentCount,
    processedSegmentCount,
    updatedAt,
  }) {
    const current = getMockStore().personalMediaUploadsById.get(uploadId);
    if (
      !current ||
      current.status !== "processing" ||
      current.processingOwnerInstanceId !== instanceId
    ) {
      return false;
    }
    getMockStore().personalMediaUploadsById.set(uploadId, {
      ...current,
      segmentCount,
      uploadedSegmentCount,
      processedSegmentCount,
      updatedAt,
    });
    return true;
  },
};

export function getPersonalMediaUploadRepository(): PersonalMediaUploadRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
