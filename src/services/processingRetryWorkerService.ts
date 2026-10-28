import { randomUUID } from "node:crypto";
import {
  PROCESSING_RETRY_CLAIM_RENEWAL_MS,
  PROCESSING_RETRY_CLAIM_SECONDS,
  PROCESSING_RETRY_MAX_CONCURRENT,
  PROCESSING_RETRY_POLL_INTERVAL_MS,
  PROCESSING_RETRY_SAVE_ATTEMPTS,
} from "../constants";
import { getMeetingUpdateDeliveryRepository } from "../db";
import { processingRetryJobs } from "../metrics";
import type { MeetingUpdateDeliveryRepository } from "../repositories/meetingUpdateDeliveryRepository";
import {
  getProcessingRetryRepository,
  type ProcessingRetryRepository,
} from "../repositories/processingRetryRepository";
import type { MeetingHistory } from "../types/db";
import type {
  ProcessingRetryFailureReason,
  ProcessingRetryJob,
} from "../types/meetingProcessingRetry";
import {
  readMeetingUpdateRevisions,
  type MeetingUpdateKey,
  type MeetingUpdateMutation,
} from "../types/meetingUpdateDelivery";
import { captureEvent } from "./analyticsService";
import type { RecoveryReader } from "./meetingRecoveryContent";
import {
  updateMeeting,
  type MeetingUpdateActionInput,
} from "./meetingUpdateService";
import { isProcessingRetryAvailable } from "./processingRetryAvailability";
import {
  runProcessingRetryStages,
  type ProcessingRetryChanges,
  type ProcessingRetryRun,
} from "./processingRetryStages";
import { createRecordingCheckpointService } from "./recordingCheckpointService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import {
  beginRuntimeWorkClaim,
  type RuntimeWorkClaim,
} from "./runtimeWorkAdmissionService";

/** Task 8's CloudWatch alarm matches this exact line. */
export const PROCESSING_RETRY_WORKER_FAILED_LOG =
  "Processing retry worker failed";
const IDLE_LOG =
  "Processing retry worker idle: flag off or ProcessingRetryDueIndex not ACTIVE";

type RetryWork = Pick<
  RuntimeWorkClaim,
  | "signal"
  | "trackPromise"
  | "trackEffect"
  | "authority"
  | "recordClaim"
  | "claimed"
  | "acknowledgeTerminal"
  | "acknowledgeReadOnlyRecoveryPoll"
  | "fence"
  | "settle"
>;
export type ProcessingRetryWorkerDependencies = {
  repository: ProcessingRetryRepository;
  rows: Pick<MeetingUpdateDeliveryRepository, "getStrong">;
  begin(domain: "recovery", id: string): RetryWork;
  run: typeof runProcessingRetryStages;
  save: typeof updateMeeting;
  available(): Promise<boolean>;
  reader(): RecoveryReader;
  now(): number;
  instanceId(): string;
};
type Claim = NonNullable<ProcessingRetryJob["claim"]>;
type ClaimedJob = {
  key: MeetingUpdateKey;
  work: RetryWork;
  history: MeetingHistory;
  job: ProcessingRetryJob;
  claim: Claim;
  startedAt: number;
};
type Sources = Pick<ProcessingRetryJob, "settingsSource" | "transcriptSource">;
type ContentChanges = Extract<
  MeetingUpdateMutation,
  { kind: "regeneration" }
>["changes"];
type ConflictVerdict = "saved" | "lost" | "notes_changed" | "retry";

// A fenced work handle refuses trackEffect, yet its claim-conditioned terminal write must still run.
const untracked: RetryWork["trackEffect"] = (run) => run();
const notesVersionOf = (row: Pick<MeetingHistory, "notesVersion">) =>
  readMeetingUpdateRevisions(row).notesVersion;

/** Every terminal outcome counts as one attempt; the request never counts it. */
function terminalJob(
  job: ProcessingRetryJob,
  sources: Sources,
  failureReason?: ProcessingRetryFailureReason,
): ProcessingRetryJob {
  const terminal: ProcessingRetryJob = {
    ...job,
    settingsSource: sources.settingsSource,
    transcriptSource: sources.transcriptSource,
    status: failureReason ? "failed" : "succeeded",
    countedAttempts: job.countedAttempts + 1,
    updatedAt: new Date().toISOString(),
  };
  delete terminal.claim;
  delete terminal.failureReason;
  return failureReason ? { ...terminal, failureReason } : terminal;
}

function regenerationChanges(changes: ProcessingRetryChanges): ContentChanges {
  const result: ContentChanges = [];
  if (changes.notes !== undefined)
    result.push({ kind: "notes", notes: changes.notes });
  if (changes.summarySentence !== undefined)
    result.push({ kind: "summarySentence", value: changes.summarySentence });
  if (changes.summaryLabel !== undefined)
    result.push({ kind: "summaryLabel", value: changes.summaryLabel });
  if (changes.meetingName)
    result.push({ kind: "rename", meetingName: changes.meetingName });
  return result;
}

function saveInput(
  claimed: ClaimedJob,
  changes: ProcessingRetryChanges,
  job: ProcessingRetryJob,
): MeetingUpdateActionInput {
  const { jobId, expectedNotesVersion, requestedBy } = claimed.job;
  return {
    key: claimed.key,
    mutation: { kind: "regeneration", changes: regenerationChanges(changes) },
    actor: { editedBy: requestedBy },
    ...(changes.notes !== undefined
      ? {
          notesEdit: {
            expectedNotesVersion,
            source: { type: "processing_retry", jobId },
          },
        }
      : {}),
    regeneration: {
      expected: {
        jobId,
        ownerInstanceId: claimed.claim.ownerInstanceId,
        claimId: claimed.claim.claimId,
        expectedNotesVersion,
      },
      processing: changes.processing,
      transcriptS3Key: changes.transcriptS3Key,
      job,
    },
  };
}

export function createProcessingRetryWorker(
  deps: ProcessingRetryWorkerDependencies,
) {
  const jobs = new Set<Promise<void>>();
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let idle = false;

  async function claimJob(
    key: MeetingUpdateKey,
    work: RetryWork,
    submitted: () => void,
  ): Promise<ClaimedJob | undefined> {
    const authority = await work.authority();
    if (authority.kind !== "serving") return undefined;
    const history = await deps.rows.getStrong(key, work.signal);
    const queued = history?.processingRetry;
    if (!history || !queued) return undefined;
    const now = deps.now();
    const claim: Claim = {
      ownerInstanceId: deps.instanceId(),
      claimId: randomUUID(),
      leaseExpiresAt: now + PROCESSING_RETRY_CLAIM_SECONDS,
    };
    // Recorded before the write, so a claim whose outcome is unknown stays reconcilable.
    work.recordClaim({
      claimId: claim.claimId,
      instanceId: claim.ownerInstanceId,
      expiresAt: claim.leaseExpiresAt,
    });
    submitted();
    const job = await deps.repository.claim({
      key,
      jobId: queued.jobId,
      ...claim,
      now,
      authority,
      signal: work.signal,
    });
    if (!job?.claim) {
      // The write was refused, so the recorded claim never existed.
      work.acknowledgeTerminal();
      return undefined;
    }
    work.claimed();
    return {
      key,
      work,
      history: { ...history, processingRetry: job },
      job,
      claim: job.claim,
      startedAt: Date.now(),
    };
  }

  async function renewOnce(claimed: ClaimedJob) {
    const leaseExpiresAt = deps.now() + PROCESSING_RETRY_CLAIM_SECONDS;
    const { claimId, ownerInstanceId } = claimed.claim;
    const renewed = await deps.repository.renew({
      key: claimed.key,
      jobId: claimed.job.jobId,
      ownerInstanceId,
      claimId,
      leaseExpiresAt,
    });
    if (!renewed) throw new Error("Processing retry lease lost");
    claimed.work.recordClaim({
      claimId,
      instanceId: ownerInstanceId,
      expiresAt: leaseExpiresAt,
    });
  }

  /** Returns the stop, which waits out an in-flight renewal so terminal writes see a settled claim. */
  function renewLease(claimed: ClaimedJob): () => Promise<void> {
    const { work } = claimed;
    let renewing: Promise<void> | undefined;
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = work
        .trackEffect(() => renewOnce(claimed))
        .catch(() => work.fence())
        .finally(() => {
          renewing = undefined;
        });
    }, PROCESSING_RETRY_CLAIM_RENEWAL_MS);
    renewal.unref();
    return async () => {
      clearInterval(renewal);
      await renewing;
    };
  }

  async function failJob(
    claimed: ClaimedJob,
    sources: Sources,
    reason: ProcessingRetryFailureReason,
    write: RetryWork["trackEffect"] = claimed.work.trackEffect,
  ): Promise<ProcessingRetryJob | undefined> {
    const failed = terminalJob(claimed.job, sources, reason);
    const result = await write(() =>
      deps.repository.fail({
        key: claimed.key,
        expected: claimed.job,
        failed,
      }),
    );
    return result === "applied" ? failed : undefined;
  }

  async function readOwnJob(
    claimed: ClaimedJob,
    read: RetryWork["trackEffect"],
  ) {
    const row = await read(() => deps.rows.getStrong(claimed.key));
    const job = row?.processingRetry;
    return row && job?.jobId === claimed.job.jobId ? { row, job } : undefined;
  }

  async function afterConflict(claimed: ClaimedJob): Promise<ConflictVerdict> {
    const own = await readOwnJob(claimed, claimed.work.trackEffect);
    if (!own) return "lost";
    const { row, job } = own;
    if (job.status === "succeeded") return "saved";
    if (
      job.status !== "running" ||
      job.claim?.claimId !== claimed.claim.claimId ||
      job.claim.ownerInstanceId !== claimed.claim.ownerInstanceId
    )
      return "lost";
    return notesVersionOf(row) !== claimed.job.expectedNotesVersion
      ? "notes_changed"
      : "retry";
  }

  async function saveJob(
    claimed: ClaimedJob,
    run: Extract<ProcessingRetryRun, { kind: "succeeded" }>,
  ): Promise<ProcessingRetryJob | undefined> {
    const succeeded = terminalJob(claimed.job, run);
    const input = saveInput(claimed, run.changes, succeeded);
    for (let attempt = 0; attempt < PROCESSING_RETRY_SAVE_ATTEMPTS; attempt++) {
      const result = await claimed.work.trackEffect(() => deps.save(input));
      if (result.kind === "saved") return succeeded;
      const verdict = await afterConflict(claimed);
      if (verdict === "saved") return succeeded;
      if (verdict === "lost") return undefined;
      if (verdict === "notes_changed")
        return failJob(claimed, run, "notes_changed");
    }
    console.error(PROCESSING_RETRY_WORKER_FAILED_LOG, {
      meetingId: claimed.history.meetingId,
      jobId: claimed.job.jobId,
      reason: "save attempts exhausted",
    });
    return failJob(claimed, run, "unknown");
  }

  function runJob(claimed: ClaimedJob): Promise<ProcessingRetryRun> {
    const { history, job, work } = claimed;
    if (notesVersionOf(history) !== job.expectedNotesVersion)
      return Promise.resolve({
        kind: "failed",
        reason: "notes_changed",
        settingsSource: job.settingsSource,
        transcriptSource: job.transcriptSource,
      });
    return deps.run({
      history,
      job,
      signal: work.signal,
      effect: work.trackEffect,
      reader: deps.reader(),
    });
  }

  function completed(claimed: ClaimedJob, job: ProcessingRetryJob) {
    claimed.work.acknowledgeTerminal();
    processingRetryJobs.inc({
      outcome: job.status,
      reason: job.failureReason ?? "none",
    });
    captureEvent("meeting_processing_retry_completed", {
      userId: job.requestedBy,
      guildId: claimed.key.guildId,
      properties: {
        outcome: job.status,
        failure_reason: job.failureReason,
        stages: job.stages,
        transcript_source: job.transcriptSource,
        settings_source: job.settingsSource,
        duration_ms: Date.now() - claimed.startedAt,
        counted_attempts: job.countedAttempts,
      },
    });
  }

  async function failUnexpected(claimed: ClaimedJob, error: unknown) {
    claimed.work.fence();
    console.error(PROCESSING_RETRY_WORKER_FAILED_LOG, {
      meetingId: claimed.history.meetingId,
      jobId: claimed.job.jobId,
      error,
    });
    try {
      const failed = await failJob(claimed, claimed.job, "unknown", untracked);
      // A refused fail may mean the save committed before it threw.
      const own = failed ? undefined : await readOwnJob(claimed, untracked);
      const terminal =
        failed ?? (own?.job.status === "succeeded" ? own.job : undefined);
      if (terminal) completed(claimed, terminal);
    } catch (failError) {
      console.error(PROCESSING_RETRY_WORKER_FAILED_LOG, failError);
    }
  }

  async function execute(claimed: ClaimedJob) {
    const stopRenewal = renewLease(claimed);
    try {
      const run = await runJob(claimed);
      await stopRenewal();
      const terminal =
        run.kind === "failed"
          ? await failJob(claimed, run, run.reason)
          : await saveJob(claimed, run);
      if (terminal) completed(claimed, terminal);
    } catch (error) {
      await stopRenewal();
      // A lost lease or shutdown is not an outcome: the lease lapses and the job is claimed again.
      if (claimed.work.signal.aborted) return;
      await failUnexpected(claimed, error);
    }
  }

  async function processKey(
    key: MeetingUpdateKey,
    work: RetryWork,
    admitted: () => void,
  ) {
    let submitted = false;
    try {
      const claimed = await claimJob(key, work, () => {
        submitted = true;
      });
      admitted();
      if (claimed) await execute(claimed);
    } catch (error) {
      // Shutdown or a lost lease is expected on every deploy and must not page.
      const cancelled = work.signal.aborted;
      // A claim that may have committed stays unresolved instead of being released.
      if (submitted) work.fence();
      if (!cancelled) console.error(PROCESSING_RETRY_WORKER_FAILED_LOG, error);
    } finally {
      admitted();
      // Without a claim, a fenced recovery handle is released only by this acknowledgment.
      if (!submitted) work.acknowledgeReadOnlyRecoveryPoll();
      await work.settle();
    }
  }

  /** Resolves once the job is running or was skipped, so poll counts it before the next key. */
  function startJob(key: MeetingUpdateKey): Promise<void> {
    let work: RetryWork;
    try {
      work = deps.begin(
        "recovery",
        `processing-retry:${key.guildId}:${key.channelId_timestamp}`,
      );
    } catch {
      return Promise.resolve();
    }
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const job = work.trackPromise(() => processKey(key, work, admitted));
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return ready;
  }

  async function pollDue() {
    if (!(await deps.available())) {
      if (!idle) console.warn(IDLE_LOG);
      idle = true;
      return;
    }
    idle = false;
    const limit = PROCESSING_RETRY_MAX_CONCURRENT - jobs.size;
    if (limit <= 0) return;
    const keys = await deps.repository.listDue({ now: deps.now(), limit });
    for (const key of keys) {
      if (stopped) return;
      await startJob(key);
    }
  }

  function poll(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    const actual = pollDue()
      .catch((error) =>
        console.error(PROCESSING_RETRY_WORKER_FAILED_LOG, error),
      )
      .finally(() => {
        pending = undefined;
      });
    pending = actual;
    return actual;
  }

  async function drain() {
    while (pending || jobs.size) await Promise.allSettled([pending, ...jobs]);
  }

  return {
    poll,
    drain,
    start() {
      if (stopped || timer) return;
      void poll();
      timer = setInterval(() => {
        void poll();
      }, PROCESSING_RETRY_POLL_INTERVAL_MS);
      timer.unref();
    },
    stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      return drain();
    },
  };
}

let worker: ReturnType<typeof createProcessingRetryWorker> | undefined;
let sealed = false;
export function startProcessingRetryWorker() {
  if (sealed || worker) return;
  worker = createProcessingRetryWorker({
    repository: getProcessingRetryRepository(),
    rows: getMeetingUpdateDeliveryRepository(),
    begin: beginRuntimeWorkClaim,
    run: runProcessingRetryStages,
    save: updateMeeting,
    available: isProcessingRetryAvailable,
    reader: () => createRecordingCheckpointService(),
    now: () => Math.floor(Date.now() / 1000),
    instanceId: getRuntimeInstanceId,
  });
  worker.start();
}
export function stopProcessingRetryWorker(): Promise<void> {
  sealed = true;
  return worker?.stop() ?? Promise.resolve();
}
