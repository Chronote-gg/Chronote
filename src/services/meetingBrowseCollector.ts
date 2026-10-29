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
type CollectorInput = {
  state: MeetingBrowseCursorPayload;
  limit: number;
  read: (
    source: MeetingBrowseSource,
    options: MeetingBrowsePageOptions,
  ) => Promise<MeetingBrowsePage<MeetingBrowseLookup>>;
  authorize: (key: MeetingBrowseLookup) => Promise<MeetingHistory | undefined>;
};
type BrowseTie = NonNullable<MeetingBrowseCursorPayload["tie"]>;
type FrontierHead = {
  index: number;
  item: MeetingBrowsePage<MeetingBrowseLookup>["items"][number];
};

class MeetingBrowseCollector {
  private readonly pages = new Map<
    number,
    MeetingBrowsePage<MeetingBrowseLookup>
  >();
  private readonly output: MeetingHistory[] = [];
  private examined = 0;
  private reads = 0;
  private best: MeetingHistory[] = [];
  private readonly state: MeetingBrowseCursorPayload;
  private readonly limit: number;
  constructor(private readonly input: CollectorInput) {
    this.state = input.state;
    this.limit = input.limit;
  }
  private async restorePending() {
    for (const key of this.state.pending) {
      this.examined++;
      const record = await this.input.authorize(key);
      if (record) this.best.push(record);
    }
    this.state.pending = [];
    // Revocation can remove the best keys saved in a truncated tie. The unseen
    // runners-up may outrank the remaining scan tail, so rebuild before emitting.
    if (this.state.tie?.overflow && this.best.length < this.limit) {
      this.state.sources = this.state.tie.starts;
      this.state.tie = undefined;
      this.best = [];
    }
  }
  private pastWatermark = (key: MeetingBrowseLookup) =>
    !this.state.watermark ||
    key.timestamp < this.state.watermark.timestamp ||
    (key.timestamp === this.state.watermark.timestamp &&
      identity(key).localeCompare(this.state.watermark.identity) < 0);
  private async fronts() {
    for (let index = 0; index < this.state.sources.length; index++) {
      const source = this.state.sources[index];
      while (!source.exhausted && !this.pages.get(index)?.items.length) {
        if (this.reads >= WORK_BUDGET) return false;
        this.reads++;
        const page = await this.input.read(source, {
          startTimestamp: this.state.startTimestamp,
          endTimestamp: this.state.endTimestamp,
          limit: STORAGE_PAGE_LIMIT,
          cursor: source.checkpoint,
        });
        this.pages.set(index, page);
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
  }
  private emitTie(tie: BrowseTie) {
    this.best.sort(compare);
    const remaining = this.limit - this.output.length;
    const selected = this.best.slice(0, remaining);
    this.output.push(...selected);
    const last = selected.at(-1);
    if (last)
      this.state.watermark = {
        timestamp: last.timestamp,
        identity: identity(last),
      };
    if (tie.overflow || this.best.length > remaining) {
      this.state.sources = tie.starts;
      this.pages.clear();
    }
    this.state.tie = undefined;
    this.best = [];
    return this.output.length >= this.limit || this.examined >= WORK_BUDGET;
  }
  private advance(next: FrontierHead) {
    const page = this.pages.get(next.index);
    if (!page) throw new Error("Missing meeting source frontier");
    const source = this.state.sources[next.index];
    source.checkpoint = meetingBrowseSourceSchema.parse({
      ...source,
      checkpoint: next.item.cursorAfter,
    }).checkpoint;
    page.items.shift();
    if (!page.items.length && !page.nextCursor) source.exhausted = true;
  }
  private async accept(key: MeetingBrowseLookup, tie: BrowseTie) {
    const record = await this.input.authorize(key);
    if (
      !record ||
      !this.pastWatermark(record) ||
      this.best.some((item) => identity(item) === identity(record))
    )
      return;
    this.best.push(record);
    this.best.sort(compare);
    if (this.best.length > this.limit + 1) {
      this.best.pop();
      tie.overflow = true;
    }
  }
  private prepareTie(heads: FrontierHead[]) {
    if (!this.state.tie) {
      const timestamp = heads
        .map(({ item }) => item.record.timestamp)
        .sort()
        .at(-1);
      if (!timestamp) return undefined;
      this.state.tie = {
        timestamp,
        starts: this.state.sources.map((source) => ({ ...source })),
        overflow: false,
      };
      this.best = [];
    }
    return this.state.tie;
  }
  async collect() {
    await this.restorePending();
    while (await this.fronts()) {
      const heads = [...this.pages.entries()].flatMap(([index, page]) =>
        page.items[0] ? [{ index, item: page.items[0] }] : [],
      );
      const tie = this.prepareTie(heads);
      if (!tie) break;
      const next = heads.find(
        ({ item }) => item.record.timestamp === tie.timestamp,
      );
      if (!next) {
        if (this.emitTie(tie)) break;
        continue;
      }
      if (this.examined >= WORK_BUDGET) break;
      this.advance(next);
      this.examined++;
      const key = next.item.record;
      if (!this.pastWatermark(key)) continue;
      await this.accept(key, tie);
    }
    this.state.pending = this.best.map(lookup);
    const discoveryComplete =
      !this.state.tie && this.state.sources.every((source) => source.exhausted);
    return { meetings: this.output, discoveryComplete };
  }
}
export async function collectMeetingBrowsePage(input: CollectorInput) {
  return new MeetingBrowseCollector(input).collect();
}
