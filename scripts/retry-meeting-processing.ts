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
 * The default is a dry run. It needs a full app environment, because
 * configService validates the whole config at import, plus production AWS
 * credentials. A production run follows the existing production approval
 * rules.
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { getProcessingRetryRepository } from "../src/repositories/processingRetryRepository";
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

async function main(args: RetryProcessingArgs) {
  if (args.apply && !(await isProcessingRetryAvailable())) {
    console.error(
      "Processing retry is not available (flag off or due index not ACTIVE). Nothing was queued.",
    );
    process.exitCode = 1;
    return;
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
  for (const key of summary.queueable) {
    if (!args.apply) {
      printKey("would_queue", key);
      continue;
    }
    const result = await requestProcessingRetry({
      key,
      requestedBy: args.operatorUserId,
      replaceNotes: false,
      source: "operator",
    });
    printKey(
      result.kind,
      key,
      result.kind === "ineligible" ? ` ${result.reason}` : "",
    );
  }
}

if (require.main === module) {
  const args = parseRetryProcessingArgs(process.argv.slice(2));
  // Only the error name is printed: a parse failure on a stored row could echo meeting content.
  main(args).catch((error: unknown) => {
    console.error(
      `Processing retry command failed (${error instanceof Error ? error.name : "unknown"}). Keys printed above were handled; rerun the dry run before retrying.`,
    );
    process.exitCode = 1;
  });
}
