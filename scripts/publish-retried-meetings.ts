/**
 * Publishes to Discord the notes of meetings a processing retry fixed before
 * a successful retry published them: such a meeting shows the failure notice
 * in Discord and its notes in the portal only. Each one is handed back to the
 * finish pipeline's delivery step through the same change a retry now makes,
 * and the finisher then edits the notice into the summary card and posts the
 * notes. Output is meeting keys and counts only.
 *
 *   npx ts-node scripts/publish-retried-meetings.ts --from <iso> --to <iso> \
 *     --operator-user-id <discordUserId> [--guild-id <id>] [--apply]
 *
 * The window matches each meeting's start time, both ends inclusive. The
 * default is a dry run. With --apply each meeting is re-read and written only
 * while it still awaits publication, so a re-run skips meetings already handed
 * back. It needs a full app environment and production AWS credentials; a
 * production run follows the existing production approval rules.
 */
import { getMeetingUpdateDeliveryRepository } from "../src/db";
import type { MeetingUpdateDeliveryRepository } from "../src/repositories/meetingUpdateDeliveryRepository";
import type { MeetingHistory } from "../src/types/db";
import { awaitsRetryPublication } from "../src/types/meetingPublication";
import type { MeetingUpdateKey } from "../src/types/meetingUpdateDelivery";
import {
  parseRetryProcessingArgs,
  scanWindow,
} from "./retry-meeting-processing";

const keyOf = (row: MeetingHistory): MeetingUpdateKey => ({
  guildId: row.guildId,
  channelId_timestamp: row.channelId_timestamp,
});

/** Sequential so each result is reported against its own key. Resolves false unless every meeting was handed back. */
export async function publishRetriedMeetings(input: {
  rows: MeetingHistory[];
  apply: boolean;
  operatorUserId: string;
  repository: Pick<MeetingUpdateDeliveryRepository, "armRetryPublication">;
}): Promise<boolean> {
  const keys = input.rows.filter(awaitsRetryPublication).map(keyOf);
  console.log(
    JSON.stringify({
      apply: input.apply,
      operatorUserId: input.operatorUserId,
      scanned: input.rows.length,
      awaitingPublication: keys.length,
    }),
  );
  const tally: Record<string, number> = {};
  for (const key of keys) {
    const result = input.apply
      ? await input.repository.armRetryPublication(key)
      : "would_publish";
    tally[result] = (tally[result] ?? 0) + 1;
    console.log(`${result} ${key.guildId} ${key.channelId_timestamp}`);
  }
  console.log(JSON.stringify({ results: tally }));
  return !input.apply || keys.length === (tally.armed ?? 0);
}

if (require.main === module) {
  const args = parseRetryProcessingArgs(process.argv.slice(2));
  void scanWindow(args)
    .then((rows) =>
      publishRetriedMeetings({
        rows,
        apply: args.apply,
        operatorUserId: args.operatorUserId,
        repository: getMeetingUpdateDeliveryRepository(),
      }),
    )
    .catch((error: unknown) => {
      // Only the error name is printed: a parse failure on a stored row could echo meeting content.
      console.error(
        `Publishing retried meetings failed (${error instanceof Error ? error.name : "unknown"}). Rerun the dry run before retrying.`,
      );
      return false;
    })
    .then((succeeded) => {
      if (!succeeded) process.exitCode = 1;
    });
}
