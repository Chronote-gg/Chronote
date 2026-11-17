import { registerNotionMutationTracker } from "./notionOperationLifetime";
import {
  PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
  PERSONAL_MEDIA_UPLOAD_WORKER_BATCH_SIZE,
  PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS,
  PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
  PERSONAL_MEDIA_UPLOAD_WORKER_POLL_INTERVAL_MS,
} from "../constants";
import { randomUUID } from "node:crypto";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import { personalMediaClaimForJob } from "../db";
import { getPersonalMediaUploadRepository } from "../repositories/personalMediaUploadRepository";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "./personalMediaUploadProcessingService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import { operationSignal } from "./shutdownSignal";
import { isEligible } from "./workerRegistry";

let workerTimer: ReturnType<typeof setInterval> | undefined;
let pendingPoll: Promise<void> | undefined;
let workerStopped = false;

const epochSeconds = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();

export async function processPersonalMediaUploadJob(
  job: PersonalMediaUploadJobRecord,
): Promise<void> {
  const repository = getPersonalMediaUploadRepository();
  const instanceId = getRuntimeInstanceId();
  const claimId = randomUUID();
  let claimed: PersonalMediaUploadJobRecord | undefined;
  try {
    claimed = await repository.claim({
      uploadId: job.uploadId,
      instanceId,
      nowEpochSeconds: epochSeconds(),
      claimExpiresAt:
        epochSeconds() + PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
      updatedAt: nowIso(),
      maxAttempts: PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
      claimId,
      expectedAttempts: job.attempts ?? 0,
    });
  } catch {
    // A refused or failed claim leaves the job for the next poll.
    return;
  }
  if (!claimed) return;
  await runClaimedUploadJob(claimed, instanceId);
}
async function runClaimedUploadJob(
  claimed: PersonalMediaUploadJobRecord,
  instanceId: string,
) {
  const repository = getPersonalMediaUploadRepository();
  const claim = personalMediaClaimForJob(claimed, instanceId);
  // Aborted when the claim can no longer be renewed, so another worker may take the job over.
  const claimLost = new AbortController();
  const signal = operationSignal(claimLost.signal);
  const unregister = registerNotionMutationTracker(signal, (run) => run());
  let durable = false;
  const loseClaim = () => {
    if (!durable) claimLost.abort();
  };
  const renewalTimer = setInterval(() => {
    repository
      .renewClaim({
        ...claim,
        claimExpiresAt:
          epochSeconds() + PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
        updatedAt: nowIso(),
      })
      .then((renewed) => {
        if (!renewed) loseClaim();
      }, loseClaim);
  }, PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS);
  renewalTimer.unref();
  try {
    signal.throwIfAborted();
    const processingJob = await createPersonalMediaProcessingMeeting(
      claimed,
      instanceId,
      signal,
    );
    signal.throwIfAborted();
    await processPersonalMediaUpload(processingJob, instanceId, signal, () => {
      durable = true;
      clearInterval(renewalTimer);
    });
  } catch {
    // Processing records its own failures on the job; anything else is recovered by claim expiry.
  } finally {
    clearInterval(renewalTimer);
    unregister();
  }
}
function pollPersonalMediaUploadJobs(): Promise<void> {
  if (workerStopped || !isEligible()) return Promise.resolve();
  if (pendingPoll) return pendingPoll;
  let complete!: () => void;
  const owned = new Promise<void>((resolve) => {
    complete = resolve;
  });
  pendingPoll = owned;
  void runPoll().finally(() => {
    pendingPoll = undefined;
    complete();
  });
  return owned;
}
async function runPoll() {
  try {
    const jobs = await getPersonalMediaUploadRepository().listClaimable({
      instanceId: getRuntimeInstanceId(),
      nowEpochSeconds: epochSeconds(),
      maxAttempts: PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
      limit: PERSONAL_MEDIA_UPLOAD_WORKER_BATCH_SIZE,
    });
    for (const job of jobs) {
      if (workerStopped) break;
      await processPersonalMediaUploadJob(job);
    }
  } catch (error) {
    console.error("Personal media upload worker failed", error);
  }
}

export function startPersonalMediaUploadWorker() {
  if (workerTimer || workerStopped) return;
  void pollPersonalMediaUploadJobs();
  workerTimer = setInterval(() => {
    void pollPersonalMediaUploadJobs();
  }, PERSONAL_MEDIA_UPLOAD_WORKER_POLL_INTERVAL_MS);
}

export function stopPersonalMediaUploadWorker(): Promise<void> {
  workerStopped = true;
  clearInterval(workerTimer);
  workerTimer = undefined;
  return pendingPoll ?? Promise.resolve();
}
