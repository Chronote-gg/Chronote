import type { MeetingHistory } from "../types/db";
import type {
  MeetingBrowsePage,
  MeetingBrowsePageOptions,
} from "../types/meetingBrowse";
import {
  meetingBrowseSourceSchema,
  type MeetingBrowseCursorPayload,
  type MeetingBrowseLookup,
  type MeetingBrowseSource,
} from "./meetingBrowseCursor";

const WORK_BUDGET = 1000;
const STORAGE_PAGE_LIMIT = 100;
const identity = (key: MeetingBrowseLookup) =>
  `${key.guildId}#${key.channelId_timestamp}`;
const compare = (a: MeetingBrowseLookup, b: MeetingBrowseLookup) =>
  b.timestamp.localeCompare(a.timestamp) ||
  identity(b).localeCompare(identity(a));
const lookup = (record: MeetingBrowseLookup): MeetingBrowseLookup => ({
  guildId: record.guildId,
  channelId_timestamp: record.channelId_timestamp,
  timestamp: record.timestamp,
});

/** Merge complete timestamp frontiers. No projected content is retained in cursor state.
 * Reads are deliberately sequential (one in flight, below the four-read ceiling).
 * A large tie retains only its best page and restarts from the tie's checkpoints
 * after emission, using the identity watermark to recover every lower-ranked row.
 */
export async function collectMeetingBrowsePage(input: {
  state: MeetingBrowseCursorPayload;
  limit: number;
  read: (
    source: MeetingBrowseSource,
    options: MeetingBrowsePageOptions,
  ) => Promise<MeetingBrowsePage<MeetingBrowseLookup>>;
  authorize: (key: MeetingBrowseLookup) => Promise<MeetingHistory | undefined>;
}) {
  const { state, limit } = input;
  const pages = new Map<number, MeetingBrowsePage<MeetingBrowseLookup>>();
  const output: MeetingHistory[] = [];
  let examined = 0;
  let reads = 0;
  let best: MeetingHistory[] = [];
  for (const key of state.pending) {
    examined++;
    const record = await input.authorize(key);
    if (record) best.push(record);
  }
  state.pending = [];
  // Revocation can remove the best keys saved in a truncated tie. The unseen
  // runners-up may outrank the remaining scan tail, so rebuild before emitting.
  if (state.tie?.overflow && best.length < limit) {
    state.sources = state.tie.starts;
    state.tie = undefined;
    best = [];
  }
  const pastWatermark = (key: MeetingBrowseLookup) =>
    !state.watermark ||
    key.timestamp < state.watermark.timestamp ||
    (key.timestamp === state.watermark.timestamp &&
      identity(key).localeCompare(state.watermark.identity) < 0);
  const fronts = async () => {
    for (let index = 0; index < state.sources.length; index++) {
      const source = state.sources[index];
      while (!source.exhausted && !pages.get(index)?.items.length) {
        if (reads >= WORK_BUDGET) return false;
        reads++;
        const page = await input.read(source, {
          startTimestamp: state.startTimestamp,
          endTimestamp: state.endTimestamp,
          limit: STORAGE_PAGE_LIMIT,
          cursor: source.checkpoint,
        });
        pages.set(index, page);
        if (page.items.length) break;
        if (!page.nextCursor) source.exhausted = true;
        else
          source.checkpoint = meetingBrowseSourceSchema.parse({
            ...source,
            checkpoint: page.nextCursor,
          }).checkpoint;
      }
    }
    return true;
  };
  while (await fronts()) {
    const heads = [...pages.entries()].flatMap(([index, page]) =>
      page.items[0] ? [{ index, item: page.items[0] }] : [],
    );
    if (!state.tie) {
      const timestamp = heads
        .map(({ item }) => item.record.timestamp)
        .sort()
        .at(-1);
      if (!timestamp) break;
      state.tie = {
        timestamp,
        starts: state.sources.map((source) => ({ ...source })),
        overflow: false,
      };
      best = [];
    }
    const tie = state.tie;
    const next = heads.find(
      ({ item }) => item.record.timestamp === tie.timestamp,
    );
    if (!next) {
      best.sort(compare);
      const remaining = limit - output.length;
      const selected = best.slice(0, remaining);
      output.push(...selected);
      const last = selected.at(-1);
      if (last)
        state.watermark = {
          timestamp: last.timestamp,
          identity: identity(last),
        };
      if (tie.overflow || best.length > remaining) {
        state.sources = tie.starts;
        pages.clear();
      }
      state.tie = undefined;
      best = [];
      if (output.length >= limit || examined >= WORK_BUDGET) break;
      continue;
    }
    if (examined >= WORK_BUDGET) break;
    const page = pages.get(next.index);
    if (!page) throw new Error("Missing meeting source frontier");
    const source = state.sources[next.index];
    source.checkpoint = meetingBrowseSourceSchema.parse({
      ...source,
      checkpoint: next.item.cursorAfter,
    }).checkpoint;
    page.items.shift();
    if (!page.items.length && !page.nextCursor) source.exhausted = true;
    examined++;
    const key = next.item.record;
    if (!pastWatermark(key)) continue;
    const record = await input.authorize(key);
    if (
      !record ||
      !pastWatermark(record) ||
      best.some((item) => identity(item) === identity(record))
    )
      continue;
    best.push(record);
    best.sort(compare);
    if (best.length > limit + 1) {
      best.pop();
      tie.overflow = true;
    }
  }
  state.pending = best.map(lookup);
  const discoveryComplete =
    !state.tie && state.sources.every((source) => source.exhausted);
  return { meetings: output, discoveryComplete };
}
