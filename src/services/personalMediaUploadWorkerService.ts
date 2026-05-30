import {
  PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
  PERSONAL_MEDIA_UPLOAD_WORKER_BATCH_SIZE,
  PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS,
  PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
  PERSONAL_MEDIA_UPLOAD_WORKER_POLL_INTERVAL_MS,
} from "../constants";
import { getPersonalMediaUploadRepository } from "../repositories/personalMediaUploadRepository";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "./personalMediaUploadProcessingService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";

let workerTimer: ReturnType<typeof setInterval> | undefined;
let pollInProgress = false;

const epochSeconds = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();

const renewClaim = async (uploadId: string, instanceId: string) =>
  getPersonalMediaUploadRepository().renewClaim({
    uploadId,
    instanceId,
    claimExpiresAt: epochSeconds() + PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
    updatedAt: nowIso(),
  });

const startClaimRenewal = (uploadId: string, instanceId: string) =>
  setInterval(() => {
    void renewClaim(uploadId, instanceId).catch((error) => {
      console.error("Personal media upload claim renewal failed", {
        uploadId,
        error,
      });
    });
  }, PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS);

async function pollPersonalMediaUploadJobs() {
  if (pollInProgress) return;
  pollInProgress = true;
  const repository = getPersonalMediaUploadRepository();
  const instanceId = getRuntimeInstanceId();
  try {
    const jobs = await repository.listClaimable({
      instanceId,
      nowEpochSeconds: epochSeconds(),
      maxAttempts: PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
      limit: PERSONAL_MEDIA_UPLOAD_WORKER_BATCH_SIZE,
    });
    for (const job of jobs) {
      const claimed = await repository.claim({
        uploadId: job.uploadId,
        instanceId,
        nowEpochSeconds: epochSeconds(),
        claimExpiresAt:
          epochSeconds() + PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
        updatedAt: nowIso(),
        maxAttempts: PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
      });
      if (!claimed) continue;
      const renewalTimer = startClaimRenewal(claimed.uploadId, instanceId);
      try {
        const processingJob = await createPersonalMediaProcessingMeeting(
          claimed,
          instanceId,
        );
        await processPersonalMediaUpload(processingJob, instanceId);
      } finally {
        clearInterval(renewalTimer);
      }
    }
  } catch (error) {
    console.error("Personal media upload worker failed", error);
  } finally {
    pollInProgress = false;
  }
}

export function startPersonalMediaUploadWorker() {
  if (workerTimer) return;
  void pollPersonalMediaUploadJobs();
  workerTimer = setInterval(() => {
    void pollPersonalMediaUploadJobs();
  }, PERSONAL_MEDIA_UPLOAD_WORKER_POLL_INTERVAL_MS);
}

export function stopPersonalMediaUploadWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = undefined;
}
