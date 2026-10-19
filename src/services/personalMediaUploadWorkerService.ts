import { registerRuntimeNotionOwner } from "./notionOperationLifetime";
import {
  PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
  PERSONAL_MEDIA_UPLOAD_WORKER_BATCH_SIZE,
  PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS,
  PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
  PERSONAL_MEDIA_UPLOAD_WORKER_POLL_INTERVAL_MS,
} from "../constants";
import { randomUUID } from "node:crypto";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import type { AdmissionContext } from "../types/deploymentControl";
import { personalMediaClaimForJob } from "../db";
import {
  beginRuntimeWorkClaim,
  type RuntimeWorkClaim,
} from "./runtimeWorkAdmissionService";
import { getPersonalMediaUploadRepository } from "../repositories/personalMediaUploadRepository";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "./personalMediaUploadProcessingService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";

let workerTimer: ReturnType<typeof setInterval> | undefined;
let pendingPoll: Promise<void> | undefined;
let workerStopped = false;

const epochSeconds = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();

export function processPersonalMediaUploadJob(
  job: PersonalMediaUploadJobRecord,
): Promise<void> {
  let work: RuntimeWorkClaim;
  try {
    work = beginRuntimeWorkClaim("personal", job.uploadId);
  } catch {
    return Promise.resolve();
  }
  return work.trackPromise(() => runUploadJob(job, work));
}
async function runUploadJob(
  job: PersonalMediaUploadJobRecord,
  work: RuntimeWorkClaim,
) {
  let context: AdmissionContext;
  try {
    const authority = await work.authority();
    if (authority.kind !== "serving")
      throw new Error("Personal processing requires serving admission");
    context = authority.context;
  } catch {
    await work.settle();
    return;
  }
  const repository = getPersonalMediaUploadRepository();
  const instanceId = getRuntimeInstanceId();
  const claimId = randomUUID();
  work.recordClaim({
    claimId,
    instanceId,
    attempt: (job.attempts ?? 0) + 1,
    expiresAt: epochSeconds() + PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
  });
  let claimed;
  try {
    claimed = await repository.claim({
      uploadId: job.uploadId,
      instanceId,
      nowEpochSeconds: epochSeconds(),
      claimExpiresAt:
        epochSeconds() + PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
      updatedAt: nowIso(),
      maxAttempts: PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS,
      context,
      claimId,
      expectedAttempts: job.attempts ?? 0,
    });
    if (!claimed) {
      await work.settle();
      return;
    }
    work.claimed();
  } catch {
    work.fence();
    await work.settle();
    return;
  }
  const unregister = registerRuntimeNotionOwner(work);
  let durable = false;
  const renewalTimer = setInterval(() => {
    void work
      .trackEffect(() =>
        repository
          .renewClaim({
            ...personalMediaClaimForJob(claimed, instanceId),
            claimExpiresAt:
              epochSeconds() + PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_SECONDS,
            updatedAt: nowIso(),
          })
          .then(
            (renewed) => {
              if (!renewed && !durable) work.fence();
            },
            () => {
              if (!durable) work.fence();
            },
          ),
      )
      .catch(() => {});
  }, PERSONAL_MEDIA_UPLOAD_WORKER_CLAIM_RENEWAL_MS);
  renewalTimer.unref();
  try {
    work.signal.throwIfAborted();
    const processingJob = await createPersonalMediaProcessingMeeting(
      claimed,
      instanceId,
      work.signal,
    );
    work.signal.throwIfAborted();
    await processPersonalMediaUpload(
      processingJob,
      instanceId,
      work.signal,
      () => {
        durable = true;
        work.acknowledgeTerminal();
        clearInterval(renewalTimer);
        work.delivering();
      },
    );
    const terminal = await repository.get(job.uploadId);
    if (
      !terminal ||
      terminal.processingClaimId !== claimId ||
      terminal.status === "processing"
    )
      work.fence();
  } catch {
    work.fence();
  } finally {
    clearInterval(renewalTimer);
    await work.settle();
    unregister();
  }
}
function pollPersonalMediaUploadJobs(): Promise<void> {
  if (workerStopped) return Promise.resolve();
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
