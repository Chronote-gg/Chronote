/**
 * Meetings left unfinished by the runtime that predates the lifecycle marker.
 * The finisher loop never touches them; these commands handle them one at a
 * time, deliberately.
 *
 *   npx ts-node scripts/stranded-meetings.ts list --out <new directory>
 *   npx ts-node scripts/stranded-meetings.ts finish <guildId> <channelId_timestamp> --post | --no-post
 *
 * `list` writes every stranded meeting, with what its checkpoint manifest
 * claims and whether a live lease still names it, to `stranded.json` in a new
 * owner-only directory and prints only the count.
 *
 * `finish` claims the meeting as an operator and runs the recovery loader and
 * the finish pipeline. It refuses a meeting whose live lease names it: the old
 * runtime holds its lease until processing ends, so something is still working
 * on it. --post delivers to Discord. --no-post posts nothing to Discord, but
 * the meeting is otherwise finished as normal, so the Notion export automation
 * and the completion analytics event still run. It removes a recovery value the
 * old runtime left, which would otherwise keep the meeting reading as still
 * being published, so the meeting ends settled and unpublished.
 *
 * It runs its own retries, on the pipeline's backoff and bounded to the first
 * two steps, so a meeting is never left with a retry for anything else to pick
 * up. When it still cannot finish, or on Ctrl-C, it puts a row that still
 * needs processing back exactly as it found it. A meeting whose notes were
 * already saved keeps them and its final status, and only its claim is
 * released (also on Ctrl-C); a rerun with --post posts its notes. Only `finished`
 * exits 0: a meeting that ended `failed` (no saved audio, or a give-up after
 * retries) and a delivery recorded as failed exit 1 like every other result.
 *
 * Output is result kinds only. It needs a full app environment, because
 * configService validates the whole config at import, plus the target
 * environment's AWS credentials. A production run follows the existing
 * production approval rules.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { getMeetingFinishRepository } from "../src/repositories/meetingFinishRepository";
import type {
  FinishClaim,
  FinisherRow,
  MeetingFinishRepository,
} from "../src/repositories/meetingFinishRepository";
import { getMeetingLeaseRepository } from "../src/repositories/meetingLeaseRepository";
import { shutdownAnalytics } from "../src/services/analyticsService";
import { finishMeeting } from "../src/services/meetingFinish";
import {
  loadRecoveryFinishInput,
  type FinishInput,
} from "../src/services/meetingFinishInput";
import {
  abandonedCaptureEnd,
  readAdoptedCaptureEnd,
  manifestCoverageReader,
  type CoverageReader,
} from "../src/services/meetingFinisher";
import {
  createRecordingCheckpointService,
  manifestCaptureCoverage,
} from "../src/services/recordingCheckpointService";
import type { ActiveMeetingLease, MeetingHistory } from "../src/types/db";
import type { HistoryKey } from "../src/types/meetingHistoryTransition";
import {
  MEETING_STATUS,
  type MeetingStatus,
} from "../src/types/meetingLifecycle";
import type {
  CaptureCoverage,
  RecordingCheckpoint,
} from "../src/types/recordingCheckpoint";
import { privateDirectory, privateFile } from "./privateOutput";

type StrandedCommand =
  | { kind: "list"; out: string }
  | { kind: "finish"; key: HistoryKey; deliver: boolean };

export type FinishStrandedResult =
  | "finished"
  | "failed"
  | "delivery_failed"
  | "not_found"
  | "not_stranded"
  | "lease_held"
  | "not_claimable"
  | "delivery_pending"
  | "interrupted"
  | "restored"
  | "restore_refused";

const MS_PER_SECOND = 1000;
/** The first attempt plus the retries after the first two backoff steps. */
const OPERATOR_ATTEMPTS = 3;
const LIVE_STATUSES: readonly MeetingStatus[] = [
  MEETING_STATUS.STARTING,
  MEETING_STATUS.IN_PROGRESS,
];
const OPEN_STATUSES: readonly MeetingStatus[] = [
  ...LIVE_STATUSES,
  MEETING_STATUS.PROCESSING,
];
const isOpen = (status: MeetingStatus | undefined) =>
  status !== undefined && OPEN_STATUSES.includes(status);
const isLive = (status: MeetingStatus | undefined) =>
  status !== undefined && LIVE_STATUSES.includes(status);

const snowflake = z.string().regex(/^\d{17,20}$/);
const USAGE =
  "Usage: list --out <dir> | finish <guildId> <channelId_timestamp> --post|--no-post";

export function parseStrandedArgs(args: string[]): StrandedCommand {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      post: { type: "boolean", default: false },
      "no-post": { type: "boolean", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (command === "list" && rest.length === 0 && values.out) {
    if (values.post || values["no-post"]) throw new Error(USAGE);
    return { kind: "list", out: values.out };
  }
  if (command === "finish" && rest.length === 2 && !values.out) {
    if (values.post === values["no-post"])
      throw new Error("finish needs exactly one of --post or --no-post");
    const [guildId, channelId_timestamp] = rest;
    return {
      kind: "finish",
      key: {
        guildId: snowflake.parse(guildId),
        channelId_timestamp: z.string().min(1).parse(channelId_timestamp),
      },
      deliver: values.post,
    };
  }
  throw new Error(USAGE);
}

function finisherRow(history: MeetingHistory): FinisherRow {
  return {
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
    meetingId: history.meetingId,
    status: history.status,
    timestamp: history.timestamp,
    updatedAt: history.updatedAt,
    lifecycleVersion: history.lifecycleVersion,
    finish: history.finish,
    ownerInstanceId: history.ownerInstanceId,
  };
}

type LeaseReader = (
  guildId: string,
  signal: AbortSignal,
) => Promise<ActiveMeetingLease | undefined>;

async function leaseHeld(
  row: MeetingHistory,
  readLease: LeaseReader,
  nowMs: number,
  signal: AbortSignal,
) {
  const lease = await readLease(row.guildId, signal);
  return (
    lease?.meetingId === row.meetingId &&
    lease.leaseExpiresAt >= Math.floor(nowMs / MS_PER_SECOND)
  );
}

export type FinishStrandedDeps = {
  repository: Pick<
    MeetingFinishRepository,
    "read" | "claim" | "adopt" | "restoreStranded" | "releaseUnclaimed"
  >;
  finish: typeof finishMeeting;
  loadRecovery(
    history: MeetingHistory,
    signal: AbortSignal,
  ): Promise<FinishInput>;
  readCoverage: CoverageReader;
  readLease: LeaseReader;
  nowMs(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

/** An unmarked row that is open, or whose notes are saved and delivery is pending. */
const stranded = (row: MeetingHistory) =>
  row.lifecycleVersion === undefined &&
  (isOpen(row.status) || row.finish !== undefined);

/** A capture whose worker died is adopted as interrupted; anything else is claimed. */
async function take(
  row: MeetingHistory,
  deps: FinishStrandedDeps,
  signal: AbortSignal,
): Promise<FinishClaim | undefined> {
  const owner = `stranded-meetings:${randomUUID()}`;
  const operator = { operator: true };
  if (!isLive(row.status)) {
    const now = Math.floor(deps.nowMs() / MS_PER_SECOND);
    return deps.repository.claim(finisherRow(row), owner, now, operator);
  }
  const captureEnd = await readAdoptedCaptureEnd(
    row,
    deps.readCoverage,
    signal,
    deps.nowMs(),
  );
  const now = Math.floor(deps.nowMs() / MS_PER_SECOND);
  const end = abandonedCaptureEnd(row, captureEnd, now);
  return deps.repository.adopt(finisherRow(row), owner, end, now, operator);
}

async function waitForRetry(
  row: MeetingHistory,
  deps: FinishStrandedDeps,
  signal: AbortSignal,
) {
  const due = row.finish?.nextAttemptAt;
  const wait = due === undefined ? 0 : due * MS_PER_SECOND - deps.nowMs();
  if (wait > 0) await deps.sleep(wait, signal);
}

/** What a row with no finish map left says about how the meeting ended. */
function concluded(
  row: MeetingHistory,
  deliver: boolean,
): FinishStrandedResult | undefined {
  if (row.finish || isOpen(row.status)) return undefined;
  if (row.status === MEETING_STATUS.FAILED) return "failed";
  return deliver && row.delivery?.notes?.outcome === "failed"
    ? "delivery_failed"
    : "finished";
}

/** Puts a row that still needs processing back as it was; hands a delivery claim back. */
async function undo(
  row: MeetingHistory,
  before: MeetingHistory,
  claim: FinishClaim,
  deps: FinishStrandedDeps,
): Promise<FinishStrandedResult> {
  if (!isOpen(row.status)) {
    await deps.repository.releaseUnclaimed(claim);
    return "delivery_pending";
  }
  return (await deps.repository.restoreStranded(claim, before))
    ? "restored"
    : "restore_refused";
}

/**
 * Finishes one stranded meeting to a conclusion in this process. A row that
 * still needs processing at the end, or when `signal` aborts, is restored to
 * `before`, so nothing is left that a later run with other options would
 * pick up.
 */
export async function finishStranded(
  key: HistoryKey,
  deliver: boolean,
  deps: FinishStrandedDeps,
  signal: AbortSignal = new AbortController().signal,
): Promise<FinishStrandedResult> {
  const before = await deps.repository.read(key);
  if (!before) return "not_found";
  if (!stranded(before)) return "not_stranded";
  if (await leaseHeld(before, deps.readLease, deps.nowMs(), signal))
    return "lease_held";
  let current = before;
  let lastClaim: FinishClaim | undefined;
  for (let attempt = 1; attempt <= OPERATOR_ATTEMPTS; attempt++) {
    try {
      await waitForRetry(current, deps, signal);
    } catch {
      break;
    }
    if (signal.aborted) break;
    const claim = await take(current, deps, signal);
    if (!claim) break;
    lastClaim = claim;
    try {
      await deps.finish(
        claim,
        (loadSignal) => deps.loadRecovery(claim.history, loadSignal),
        { deliver, signal },
      );
    } catch (error) {
      console.error(
        `Finish attempt ${attempt} failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
    const after = await deps.repository.read(key);
    if (!after) return "not_found";
    current = after;
    const result = concluded(after, deliver);
    if (result) return result;
    if (signal.aborted || after.finish?.nextAttemptAt === undefined) break;
  }
  if (!lastClaim) return signal.aborted ? "interrupted" : "not_claimable";
  const undone = await undo(current, before, lastClaim, deps);
  return signal.aborted && undone === "restored" ? "interrupted" : undone;
}

/** What happened to the row, for results that leave the meeting unfinished. */
export function resultMessage(
  result: FinishStrandedResult,
): string | undefined {
  switch (result) {
    case "restored":
      return "The meeting could not be finished; its row was put back as it was.";
    case "interrupted":
      return "Interrupted; the meeting's row was put back as it was.";
    case "delivery_pending":
      return "The notes are saved and the meeting has its final status, but delivery did not complete; its claim was released and its delivery state kept. Rerunning with --post will post the notes.";
    case "restore_refused":
      return "The row could not be put back because another claim holds it or it changed; it was left as it is.";
    default:
      return undefined;
  }
}

type ManifestSummary = {
  artifacts: { kind: string }[];
  coverage: CaptureCoverage;
};
export type ListStrandedDeps = {
  repository: Pick<MeetingFinishRepository, "listStranded">;
  /** The manifest alone: listing never downloads audio pieces. */
  readManifest(
    checkpoint: RecordingCheckpoint,
    signal: AbortSignal,
  ): Promise<ManifestSummary>;
  readLease: LeaseReader;
};

function countByKind(items: ManifestSummary["artifacts"]) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

async function checkpointSummary(
  checkpoint: RecordingCheckpoint | undefined,
  deps: ListStrandedDeps,
  signal: AbortSignal,
) {
  if (!checkpoint) return null;
  try {
    const manifest = await deps.readManifest(checkpoint, signal);
    return {
      revision: checkpoint.revision,
      artifacts: countByKind(manifest.artifacts),
      savedDurationMs:
        manifest.coverage.kind === "verified"
          ? manifest.coverage.savedDurationMs
          : null,
    };
  } catch (error) {
    return {
      revision: checkpoint.revision,
      unreadable: error instanceof Error ? error.name : "unknown",
    };
  }
}

/** Each stranded meeting and what its checkpoint holds; identifiers stay in the private file. */
export async function listStranded(
  deps: ListStrandedDeps,
  signal: AbortSignal,
) {
  const rows = [];
  for await (const row of deps.repository.listStranded(signal))
    rows.push({
      guildId: row.guildId,
      channelId_timestamp: row.channelId_timestamp,
      meetingId: row.meetingId,
      status: row.status,
      timestamp: row.timestamp,
      capture: row.capture?.kind ?? null,
      transcriptSaved: Boolean(row.transcriptS3Key),
      notesSaved: Boolean(row.notes),
      leaseHeld: await leaseHeld(row, deps.readLease, Date.now(), signal),
      checkpoint: await checkpointSummary(row.checkpoint, deps, signal),
    });
  return rows;
}

async function main(
  command: StrandedCommand,
  signal: AbortSignal,
): Promise<boolean> {
  const repository = getMeetingFinishRepository();
  const leases = getMeetingLeaseRepository();
  const reader = createRecordingCheckpointService();
  const readLease: LeaseReader = (guildId, leaseSignal) =>
    leases.read(guildId, leaseSignal);
  if (command.kind === "list") {
    const directory = await privateDirectory(command.out);
    const rows = await listStranded(
      {
        repository,
        readLease,
        readManifest: async (checkpoint, readSignal) => {
          const manifest = await reader.readMetadata(checkpoint, readSignal);
          return {
            artifacts: manifest.artifacts,
            coverage: manifestCaptureCoverage(manifest),
          };
        },
      },
      signal,
    );
    await privateFile(
      directory,
      "stranded.json",
      JSON.stringify(rows, null, 2),
    );
    console.log(JSON.stringify({ stranded: rows.length }));
    return true;
  }
  const result = await finishStranded(
    command.key,
    command.deliver,
    {
      repository,
      finish: finishMeeting,
      loadRecovery: loadRecoveryFinishInput,
      readCoverage: manifestCoverageReader(reader),
      readLease,
      nowMs: Date.now,
      sleep: (ms, sleepSignal) => sleep(ms, undefined, { signal: sleepSignal }),
    },
    signal,
  );
  console.log(JSON.stringify({ result, deliver: command.deliver }));
  const message = resultMessage(result);
  if (message) console.error(message);
  return result === "finished";
}

if (require.main === module) {
  const command = parseStrandedArgs(process.argv.slice(2));
  const interrupt = new AbortController();
  // The first Ctrl-C stops the attempt and restores the row; a second one exits at once.
  process.once("SIGINT", () => interrupt.abort());
  void main(command, interrupt.signal)
    .catch((error: unknown) => {
      // Only the error name: a parse failure on a stored row could echo meeting content.
      console.error(
        `Stranded meetings command failed (${error instanceof Error ? error.name : "unknown"})`,
      );
      return false;
    })
    .then(async (succeeded) => {
      await shutdownAnalytics().catch(() =>
        console.error("Analytics flush failed."),
      );
      if (!succeeded) process.exitCode = 1;
    });
}
