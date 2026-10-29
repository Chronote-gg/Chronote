/**
 * Queues processing retries for meetings that failed during an incident,
 * through the same request service the portal uses. The operator bypasses
 * only the per-user attempt cap; every other eligibility rule still applies,
 * and a meeting whose retry would replace existing notes is listed and
 * skipped. Output is meeting keys, counts and reasons only.
 *
 *   npx ts-node scripts/retry-meeting-processing.ts --from <iso> --to <iso> \
 *     --operator-user-id <discordUserId> [--guild-id <id>] [--apply]
 *
 * The window matches each meeting's start time, not the time its processing
 * failed, and both ends are inclusive. A meeting can run for up to the
 * 2 hour maximum meeting duration before it is processed, so move --from back
 * by 2 hours from the incident start to catch meetings already running when
 * it began.
 *
 * The default is a dry run. With --apply the exit code is 1 when any
 * request was not queued, and a final line tallies results by kind. It needs
 * a full app environment, because configService validates the whole config
 * at import, plus production AWS credentials. A production run follows the
 * existing production approval rules.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { getProcessingRetryRepository } from "../src/repositories/processingRetryRepository";
import { shutdownAnalytics } from "../src/services/analyticsService";
import { isProcessingRetryAvailable } from "../src/services/processingRetryAvailability";
import { getProcessingRetryEligibility } from "../src/services/processingRetryEligibility";
import { requestProcessingRetry } from "../src/services/processingRetryRequestService";
import type { MeetingHistory } from "../src/types/db";
import type { MeetingUpdateKey } from "../src/types/meetingUpdateDelivery";

type RetryProcessingArgs = {
  from: string;
  to: string;
  guildId?: string;
  operatorUserId: string;
  apply: boolean;
};
type RetryCandidateSummary = {
  byStages: Record<string, number>;
  skipped: Record<string, number>;
  queueable: MeetingUpdateKey[];
  needsConfirmation: MeetingUpdateKey[];
};

const snowflake = z.string().regex(/^\d{17,20}$/);
/** Normalized so the scan's string comparison against stored timestamps holds. */
const isoTimestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export function parseRetryProcessingArgs(args: string[]): RetryProcessingArgs {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "guild-id": { type: "string" },
      "operator-user-id": { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const from = isoTimestamp.parse(values.from);
  const to = isoTimestamp.parse(values.to);
  if (from >= to) throw new Error("--from must be earlier than --to");
  return {
    from,
    to,
    ...(values["guild-id"]
      ? { guildId: snowflake.parse(values["guild-id"]) }
      : {}),
    operatorUserId: snowflake.parse(values["operator-user-id"]),
    apply: values.apply,
  };
}

const increment = (counts: Record<string, number>, name: string) => {
  counts[name] = (counts[name] ?? 0) + 1;
};
const keyOf = (row: MeetingHistory): MeetingUpdateKey => ({
  guildId: row.guildId,
  channelId_timestamp: row.channelId_timestamp,
});

export function summarizeRetryCandidates(
  rows: MeetingHistory[],
): RetryCandidateSummary {
  const summary: RetryCandidateSummary = {
    byStages: {},
    skipped: {},
    queueable: [],
    needsConfirmation: [],
  };
  for (const row of rows) {
    const eligibility = getProcessingRetryEligibility(row, "operator");
    if (!eligibility.eligible) increment(summary.skipped, eligibility.reason);
    else if (eligibility.requiresReplaceConfirm) {
      increment(summary.skipped, "replace_confirmation_required");
      summary.needsConfirmation.push(keyOf(row));
    } else {
      increment(summary.byStages, eligibility.stages.join("+"));
      summary.queueable.push(keyOf(row));
    }
  }
  return summary;
}

async function scanWindow(args: RetryProcessingArgs) {
  const repository = getProcessingRetryRepository();
  const rows: MeetingHistory[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.scan({
      from: args.from,
      to: args.to,
      guildId: args.guildId,
      cursor,
    });
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

const printKey = (label: string, key: MeetingUpdateKey, extra = "") =>
  console.log(`${label} ${key.guildId} ${key.channelId_timestamp}${extra}`);

/** Resolves false when anything that should have been queued was not. */
async function main(args: RetryProcessingArgs): Promise<boolean> {
  if (args.apply && !(await isProcessingRetryAvailable())) {
    console.error(
      "Processing retry is not available (flag off or due index not ACTIVE). Nothing was queued.",
    );
    return false;
  }
  const rows = await scanWindow(args);
  const summary = summarizeRetryCandidates(rows);
  console.log(
    JSON.stringify({
      apply: args.apply,
      scanned: rows.length,
      byStages: summary.byStages,
      skipped: summary.skipped,
    }),
  );
  for (const key of summary.needsConfirmation)
    printKey("skipped_replace_confirmation_required", key);
  if (!args.apply) {
    for (const key of summary.queueable) printKey("would_queue", key);
    return true;
  }
  const tally = await queueRetries(summary.queueable, args.operatorUserId);
  console.log(JSON.stringify({ results: tally }));
  return allQueued(tally);
}

export const allQueued = (tally: Record<string, number>) =>
  Object.keys(tally).every((kind) => kind === "queued");

/** Sequential so a conflict or failure on one meeting is reported against its own key. */
export async function queueRetries(
  keys: MeetingUpdateKey[],
  operatorUserId: string,
  request: typeof requestProcessingRetry = requestProcessingRetry,
): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (const key of keys) {
    const result = await request({
      key,
      requestedBy: operatorUserId,
      replaceNotes: false,
      source: "operator",
    });
    increment(tally, result.kind);
    printKey(
      result.kind,
      key,
      result.kind === "ineligible" ? ` ${result.reason}` : "",
    );
  }
  return tally;
}

/**
 * The analytics client batches, so queued-retry events are lost unless it is
 * flushed before exit. Resolves false when the task or the flush failed.
 */
export async function runWithAnalyticsFlush(
  task: () => Promise<boolean>,
  flush: () => Promise<void> = shutdownAnalytics,
): Promise<boolean> {
  let succeeded = false;
  try {
    succeeded = await task();
  } catch (error) {
    // Only the error name is printed: a parse failure on a stored row could echo meeting content.
    console.error(
      `Processing retry command failed (${error instanceof Error ? error.name : "unknown"}). Keys printed above were handled; rerun the dry run before retrying.`,
    );
  }
  try {
    await flush();
  } catch {
    console.error(
      "Analytics flush failed; retry request events may be missing.",
    );
    return false;
  }
  return succeeded;
}

if (require.main === module) {
  const args = parseRetryProcessingArgs(process.argv.slice(2));
  void runWithAnalyticsFlush(() => main(args)).then((succeeded) => {
    if (!succeeded) process.exitCode = 1;
  });
}
