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
import { registerNotionMutationTracker } from "./notionOperationLifetime";
import { isProcessingRetryAvailable } from "./processingRetryAvailability";
import {
  runProcessingRetryStages,
  type ProcessingRetryChanges,
  type ProcessingRetryRun,
} from "./processingRetryStages";
import { createRecordingCheckpointService } from "./recordingCheckpointService";
import { getRuntimeInstanceId } from "./runtimeInstanceService";
import { operationSignal } from "./shutdownSignal";
import { isEligible } from "./workerRegistry";

/** Task 8's CloudWatch alarm matches this exact line. */
export const PROCESSING_RETRY_WORKER_FAILED_LOG =
  "Processing retry worker failed";
const IDLE_LOG =
  "Processing retry worker idle: flag off or ProcessingRetryDueIndex not ACTIVE";

export type ProcessingRetryWorkerDependencies = {
  repository: ProcessingRetryRepository;
  rows: Pick<MeetingUpdateDeliveryRepository, "getStrong">;
  run: typeof runProcessingRetryStages;
  save: typeof updateMeeting;
  available(): Promise<boolean>;
  reader(): RecoveryReader;
  now(): number;
  instanceId(): string;
  isEligible(): boolean;
};
/** Aborted on shutdown, or by the job itself once its lease or a write's outcome is unknown. */
type JobStop = { controller: AbortController; signal: AbortSignal };
type Effect = <T>(run: () => Promise<T>) => Promise<T>;
type Claim = NonNullable<ProcessingRetryJob["claim"]>;
type ClaimedJob = {
  key: MeetingUpdateKey;
  stop: JobStop;
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

// A stopped job issues no new effects, yet its claim-conditioned terminal write must still run.
const untracked: Effect = (run) => run();
const guarded =
  (signal: AbortSignal): Effect =>
  async (run) => {
    signal.throwIfAborted();
    return run();
  };
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
    // The Notion auto-sync after the save runs as a mutation owned by this job.
    signal: claimed.stop.signal,
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
    stop: JobStop,
  ): Promise<ClaimedJob | undefined> {
    const history = await deps.rows.getStrong(key, stop.signal);
    const queued = history?.processingRetry;
    if (!history || !queued) return undefined;
    const now = deps.now();
    const claim: Claim = {
      ownerInstanceId: deps.instanceId(),
      claimId: randomUUID(),
      leaseExpiresAt: now + PROCESSING_RETRY_CLAIM_SECONDS,
    };
    // The claim's own condition is the only gate: of two workers polling one job, one claim lands.
    const job = await deps.repository.claim({
      key,
      jobId: queued.jobId,
      ...claim,
      now,
      signal: stop.signal,
    });
    if (!job?.claim) return undefined;
    return {
      key,
      stop,
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
  }

  /** Returns the stop, which waits out an in-flight renewal so terminal writes see a settled claim. */
  function renewLease(claimed: ClaimedJob): () => Promise<void> {
    const { stop } = claimed;
    let renewing: Promise<void> | undefined;
    const renewal = setInterval(() => {
      if (renewing) return;
      // Another worker may claim a job whose lease is unproven, so this one issues nothing further.
      renewing = guarded(stop.signal)(() => renewOnce(claimed))
        .catch(() => stop.controller.abort())
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
    write: Effect = guarded(claimed.stop.signal),
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

  async function readOwnJob(claimed: ClaimedJob, read: Effect) {
    const row = await read(() => deps.rows.getStrong(claimed.key));
    const job = row?.processingRetry;
    return row && job?.jobId === claimed.job.jobId ? { row, job } : undefined;
  }

  async function afterConflict(claimed: ClaimedJob): Promise<ConflictVerdict> {
    const own = await readOwnJob(claimed, guarded(claimed.stop.signal));
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
      const result = await guarded(claimed.stop.signal)(() => deps.save(input));
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
    const { history, job, stop } = claimed;
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
      signal: stop.signal,
      reader: deps.reader(),
    });
  }

  function completed(claimed: ClaimedJob, job: ProcessingRetryJob) {
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
    claimed.stop.controller.abort();
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

  /** A Notion mutation whose outcome is unknown stops the job like any other unknown write. */
  function registerNotion({ stop }: ClaimedJob) {
    return registerNotionMutationTracker(stop.signal, (run) =>
      guarded(stop.signal)(run).catch((error) => {
        stop.controller.abort();
        throw error;
      }),
    );
  }

  async function execute(claimed: ClaimedJob) {
    const stopRenewal = renewLease(claimed);
    const unregisterNotion = registerNotion(claimed);
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
      if (claimed.stop.signal.aborted) return;
      await failUnexpected(claimed, error);
    } finally {
      unregisterNotion();
    }
  }

  async function processKey(
    key: MeetingUpdateKey,
    stop: JobStop,
    started: () => void,
  ) {
    try {
      const claimed = await claimJob(key, stop);
      started();
      if (claimed) await execute(claimed);
    } catch (error) {
      // Shutdown or a lost lease is expected on every deploy and must not page.
      if (!stop.signal.aborted)
        console.error(PROCESSING_RETRY_WORKER_FAILED_LOG, error);
    } finally {
      started();
    }
  }

  /** Resolves once the job is running or was skipped, so poll counts it before the next key. */
  function startJob(key: MeetingUpdateKey): Promise<void> {
    const controller = new AbortController();
    const stop: JobStop = {
      controller,
      signal: operationSignal(controller.signal),
    };
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const job = processKey(key, stop, started);
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return ready;
  }

  async function readAvailable(): Promise<boolean> {
    try {
      return await deps.available();
    } catch (error) {
      console.warn("Could not read processing retry availability", error);
      return false;
    }
  }

  async function pollDue() {
    if (!(await readAvailable())) {
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
    if (stopped || !deps.isEligible()) return Promise.resolve();
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
    run: runProcessingRetryStages,
    save: updateMeeting,
    available: isProcessingRetryAvailable,
    reader: () => createRecordingCheckpointService(),
    now: () => Math.floor(Date.now() / 1000),
    instanceId: getRuntimeInstanceId,
    isEligible,
  });
  worker.start();
}
export function stopProcessingRetryWorker(): Promise<void> {
  sealed = true;
  return worker?.stop() ?? Promise.resolve();
}
