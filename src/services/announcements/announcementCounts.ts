import type { AnnouncementPreview } from "./announcementRunner";

export type SendCounts = {
  sent: number;
  ownerDm: number;
  failed: number;
  unknown: number;
  skipped: Record<string, number>;
};

/** Skip reasons in the order the summary line prints them. */
export const SKIP_REASONS = [
  "opted_out",
  "no_channel",
  "missing_permissions",
  "owner_dms_closed",
  "discord_error",
  "already_sent",
  "pending_unknown",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type Result = "sent" | "owner_dm" | "failed" | "unknown" | SkipReason;

export const emptyCounts = (): SendCounts => ({
  sent: 0,
  ownerDm: 0,
  failed: 0,
  unknown: 0,
  skipped: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])),
});

export const tally = (counts: SendCounts, result: Result) => {
  if (result === "sent" || result === "owner_dm") {
    counts.sent += 1;
    if (result === "owner_dm") counts.ownerDm += 1;
  } else if (result === "failed" || result === "unknown") {
    counts[result] += 1;
  } else {
    counts.skipped[result] = (counts.skipped[result] ?? 0) + 1;
  }
};

/** The counts a send of this preview would report if nothing changed. */
export const previewCounts = (preview: AnnouncementPreview): SendCounts => {
  const counts = emptyCounts();
  for (const { decision } of preview.entries)
    tally(
      counts,
      decision.kind === "skip"
        ? decision.reason
        : decision.kind === "target"
          ? "sent"
          : "owner_dm",
    );
  return counts;
};

export function summaryLine(
  announcementId: string,
  mode: "preview" | "send",
  counts: SendCounts,
): string {
  const skipped = SKIP_REASONS.map(
    (reason) => `${reason}=${counts.skipped[reason] ?? 0}`,
  );
  const totalSkipped = Object.values(counts.skipped).reduce(
    (sum, count) => sum + count,
    0,
  );
  return `announcement ${announcementId}: ${mode === "preview" ? "would_send" : "sent"}=${counts.sent} owner_dm=${counts.ownerDm} skipped=${totalSkipped} (${skipped.join(" ")}) failed=${counts.failed} unknown=${counts.unknown}`;
}
