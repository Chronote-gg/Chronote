import type { MeetingHistory, MeetingUserIndexRecord } from "../types/db";
import type { MeetingBrowsePageOptions } from "../types/meetingBrowse";

/** Adapts the existing legacy contract fixtures to the paged storage boundary. */
export function createLegacyBrowseFixture(input: {
  history: (
    guildId: string,
    start: string,
    end: string,
    limit?: number,
  ) => Promise<MeetingHistory[]>;
  index: (
    userId: string,
    start: string,
    end: string,
    limit?: number,
  ) => Promise<MeetingUserIndexRecord[]>;
  get: (guildId: string, id: string) => Promise<MeetingHistory | undefined>;
}) {
  const canonical = new Map<string, MeetingHistory>();
  const page = <T extends { timestamp: string; channelId_timestamp: string }>(
    rows: T[],
    options: MeetingBrowsePageOptions,
  ) => {
    const remaining = rows
      .filter(
        (row) =>
          row.timestamp >= options.startTimestamp &&
          row.timestamp <= options.endTimestamp,
      )
      .sort(
        (a, b) =>
          b.timestamp.localeCompare(a.timestamp) ||
          b.channelId_timestamp.localeCompare(a.channelId_timestamp),
      )
      .filter(
        (row) =>
          !options.cursor ||
          row.timestamp < (options.cursor.timestamp?.S ?? "") ||
          (row.timestamp === options.cursor.timestamp?.S &&
            row.channelId_timestamp <
              (options.cursor.channelId_timestamp?.S ?? "")),
      );
    const items = remaining.slice(0, options.limit).map((record) => ({
      record,
      cursorAfter: {
        timestamp: { S: record.timestamp },
        channelId_timestamp: { S: record.channelId_timestamp },
      },
    }));
    return {
      items,
      nextCursor:
        remaining.length > items.length ? items.at(-1)?.cursorAfter : undefined,
    };
  };
  return {
    reset: () => canonical.clear(),
    history: {
      get: async (guildId: string, id: string) =>
        canonical.get(`${guildId}#${id}`) ?? input.get(guildId, id),
      listByGuildTimestampPage: async (
        guildId: string,
        options: MeetingBrowsePageOptions,
      ) => {
        const rows = await input.history(
          guildId,
          options.startTimestamp,
          options.endTimestamp,
          options.limit,
        );
        rows.forEach((row) =>
          canonical.set(`${row.guildId}#${row.channelId_timestamp}`, row),
        );
        return page(
          rows.filter((row) => row.guildId === guildId),
          options,
        );
      },
    },
    index: {
      listByPrincipalTimestampPage: async (
        principal: string,
        options: MeetingBrowsePageOptions,
      ) =>
        principal.startsWith("GUILD_SHARE#")
          ? { items: [] }
          : page(
              await input.index(
                principal,
                options.startTimestamp,
                options.endTimestamp,
                options.limit,
              ),
              options,
            ),
    },
  };
}

export function createBrowseCursorFixture() {
  const states = new Map<string, unknown>();
  return {
    reset: () => states.clear(),
    storage: {
      putMeetingBrowseCursorState: async (id: string, state: unknown) => {
        states.set(id, structuredClone(state));
      },
      getMeetingBrowseCursorState: async (id: string) =>
        structuredClone(states.get(id)),
    },
  };
}

export const browseCursorFixture = createBrowseCursorFixture();
