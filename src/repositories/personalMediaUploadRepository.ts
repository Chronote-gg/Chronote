import { RuntimeAdmissionUnavailable } from "../services/runtimeAdmissionError";
import { config } from "../services/configService";
import {
  claimPersonalMediaUploadJob,
  getPersonalMediaUploadJob,
  listClaimablePersonalMediaUploadJobs,
  renewPersonalMediaUploadJobClaim,
  updateClaimedPersonalMediaUploadJobProgress,
  writeClaimedPersonalMediaUploadJob,
  writePersonalMediaUploadJob,
  submitPersonalMediaUploadJob,
  writePersonalHistoryUnderClaim,
  writePersonalSegmentUnderClaim,
  personalMediaClaimForJob,
  personalProcessingHistoryFields,
} from "../db";
import type {
  PersonalMediaUploadJobRecord,
  PersonalMediaClaim,
  MeetingHistory,
  PersonalRecordingSegmentRecord,
} from "../types/db";
import type { AdmissionContext } from "../types/deploymentControl";
import { mockWorkAdmissionAllowed } from "./deploymentControlRepository";
import { getMockStore } from "./mockStore";

export type PersonalMediaUploadRepository = {
  submit: (
    job: PersonalMediaUploadJobRecord,
    context: AdmissionContext,
  ) => Promise<boolean>;
  writeHistory: (
    history: MeetingHistory,
    claim: PersonalMediaClaim,
    terminalJob?: PersonalMediaUploadJobRecord,
  ) => Promise<boolean>;
  writeSegment: (
    segment: PersonalRecordingSegmentRecord,
    claim: PersonalMediaClaim,
  ) => Promise<boolean>;
  write: (
    job: PersonalMediaUploadJobRecord,
    context: AdmissionContext,
  ) => Promise<void>;
  get: (uploadId: string) => Promise<PersonalMediaUploadJobRecord | undefined>;
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
    context: AdmissionContext;
    claimId: string;
    expectedAttempts: number;
  }) => Promise<PersonalMediaUploadJobRecord | undefined>;
  renewClaim: (options: {
    uploadId: string;
    instanceId: string;
    claimExpiresAt: number;
    updatedAt: string;
    attempt: number;
    claimId: string;
    nowEpochSeconds: number;
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
    attempt: number;
    claimId: string;
    nowEpochSeconds: number;
  }) => Promise<boolean>;
};

const realRepository: PersonalMediaUploadRepository = {
  submit: submitPersonalMediaUploadJob,
  writeHistory: writePersonalHistoryUnderClaim,
  writeSegment: writePersonalSegmentUnderClaim,
  write: writePersonalMediaUploadJob,
  get: getPersonalMediaUploadJob,
  listClaimable: listClaimablePersonalMediaUploadJobs,
  claim: claimPersonalMediaUploadJob,
  renewClaim: renewPersonalMediaUploadJobClaim,
  updateClaimed: writeClaimedPersonalMediaUploadJob,
  updateProgress: updateClaimedPersonalMediaUploadJobProgress,
};

function mockClaimOwned(claim: PersonalMediaClaim): boolean {
  const job = getMockStore().personalMediaUploadsById.get(claim.uploadId);
  return Boolean(
    job &&
    job.status === "processing" &&
    job.processingOwnerInstanceId === claim.instanceId &&
    job.processingClaimId === claim.claimId &&
    job.attempts === claim.attempt &&
    (job.claimExpiresAt ?? 0) >= claim.nowEpochSeconds,
  );
}
const mockRepository: PersonalMediaUploadRepository = {
  async submit(job, context) {
    assertMockPersonalAdmission(context);
    const current = getMockStore().personalMediaUploadsById.get(job.uploadId);
    if (
      !current ||
      current.status !== "pending_upload" ||
      current.processingClaimId ||
      current.ownerUserId !== job.ownerUserId
    )
      return false;
    getMockStore().personalMediaUploadsById.set(
      job.uploadId,
      structuredClone(job),
    );
    return true;
  },
  async writeHistory(history, claim, terminalJob) {
    if (!mockClaimOwned(claim)) return false;
    const histories =
      getMockStore().meetingHistoryByGuild.get(history.guildId) ?? [];
    const index = histories.findIndex(
      (row) => row.channelId_timestamp === history.channelId_timestamp,
    );
    const previous = histories[index];
    if (
      previous &&
      (previous.meetingId !== history.meetingId ||
        previous.ownerUserId !== history.ownerUserId ||
        previous.ownershipScope !== "personal" ||
        previous.status !== "processing")
    )
      return false;
    const next = structuredClone(previous ?? history);
    if (!previous) {
      delete next.accessGrants;
      delete next.archivedAt;
      delete next.archivedByUserId;
    }
    Object.assign(
      next,
      Object.fromEntries(personalProcessingHistoryFields(history)),
    );
    if (index < 0) histories.push(next);
    else histories[index] = next;
    getMockStore().meetingHistoryByGuild.set(history.guildId, histories);
    if (terminalJob)
      getMockStore().personalMediaUploadsById.set(
        claim.uploadId,
        structuredClone(terminalJob),
      );
    return true;
  },
  async writeSegment(segment, claim) {
    if (segment.uploadId !== claim.uploadId || !mockClaimOwned(claim))
      return false;
    const segments = getMockStore().personalRecordingSegmentsByUploadId.get(
      segment.uploadId,
    );
    if (segments?.get(segment.segmentKey)?.ownerUserId !== segment.ownerUserId)
      return false;
    segments.set(segment.segmentKey, structuredClone(segment));
    return true;
  },
  async write(job, context) {
    assertMockPersonalAdmission(context);
    if (getMockStore().personalMediaUploadsById.has(job.uploadId))
      throw new Error("Upload already exists");
    getMockStore().personalMediaUploadsById.set(
      job.uploadId,
      structuredClone(job),
    );
  },
  async get(uploadId) {
    return getMockStore().personalMediaUploadsById.get(uploadId);
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
    context,
    claimId,
    expectedAttempts,
  }) {
    const job = getMockStore().personalMediaUploadsById.get(uploadId);
    if (!job) return undefined;
    if (
      job.processingClaimId === claimId &&
      job.processingOwnerInstanceId === instanceId &&
      job.status === "processing"
    )
      return (job.claimExpiresAt ?? 0) >= nowEpochSeconds
        ? structuredClone(job)
        : undefined;
    const store = getMockStore();
    if (
      context.instanceId !== instanceId ||
      !mockWorkAdmissionAllowed(
        { kind: "serving", context: { ...context, now: nowEpochSeconds } },
        store.deploymentControlRecords,
        store.activeMeetingLeases,
      ) ||
      (job.attempts ?? 0) !== expectedAttempts
    )
      return undefined;
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
      processingClaimId: claimId,
      artifactAttempts: {
        ...job.artifactAttempts,
        [attempts + 1]: {
          prefix: `personal/${job.ownerUserId}/${uploadId}/attempt-${attempts + 1}/`,
          audioS3Key: `personal/${job.ownerUserId}/${uploadId}/attempt-${attempts + 1}/audio.mp3`,
          transcriptS3Key: `personal/${job.ownerUserId}/${uploadId}/attempt-${attempts + 1}/transcript.json`,
        },
      },
      updatedAt,
    };
    getMockStore().personalMediaUploadsById.set(uploadId, next);
    return next;
  },
  async renewClaim(input) {
    const { uploadId, instanceId, claimExpiresAt, updatedAt } = input;
    if (!mockClaimOwned(input)) return false;
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
    if (!mockClaimOwned(personalMediaClaimForJob(job, instanceId)))
      return false;
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
  async updateProgress(input) {
    if (!mockClaimOwned(input)) return false;
    const {
      uploadId,
      instanceId,
      segmentCount,
      uploadedSegmentCount,
      processedSegmentCount,
      updatedAt,
    } = input;
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

export function assertMockPersonalAdmission(context: AdmissionContext): void {
  const store = getMockStore();
  if (
    !mockWorkAdmissionAllowed(
      { kind: "serving", context },
      store.deploymentControlRecords,
      store.activeMeetingLeases,
    )
  )
    throw new RuntimeAdmissionUnavailable("Runtime is not accepting work");
}
