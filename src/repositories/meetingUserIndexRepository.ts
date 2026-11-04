import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  MeetingBrowsePageOptions,
  MeetingBrowsePage,
} from "../types/meetingBrowse";
import { config } from "../services/configService";
import {
  meetingUserIndexPointerExistsStrong,
  getMeetingUserIndexTimestampPage,
  deleteMeetingUserIndexRecords,
  getMeetingUserIndexRecordsForUserInRange,
  writeMeetingUserIndexRecords,
} from "../db";
import type { MeetingUserIndexRecord } from "../types/db";
import {
  assertRawMeetingIndexUserId,
  buildGuildShareIndexRecords,
  buildMeetingUserIndexRecords,
} from "../utils/meetingUserIndex";
import { getMockStore } from "./mockStore";

export type MeetingUserIndexRepository = {
  existsStrong: typeof meetingUserIndexPointerExistsStrong;
  listByPrincipalTimestampPage: (
    principal: string,
    options: MeetingBrowsePageOptions,
  ) => Promise<MeetingBrowsePage<MeetingUserIndexRecord>>;
  write: (records: MeetingUserIndexRecord[]) => Promise<void>;
  delete: (
    records: Pick<MeetingUserIndexRecord, "userId" | "userTimestamp">[],
  ) => Promise<void>;
  listByUserTimestampRange: (
    userId: string,
    startTimestamp: string,
    endTimestamp: string,
    limit?: number,
  ) => Promise<MeetingUserIndexRecord[]>;
};

const realRepository: MeetingUserIndexRepository = {
  existsStrong: meetingUserIndexPointerExistsStrong,
  listByPrincipalTimestampPage: getMeetingUserIndexTimestampPage,
  write: writeMeetingUserIndexRecords,
  delete: deleteMeetingUserIndexRecords,
  listByUserTimestampRange: getMeetingUserIndexRecordsForUserInRange,
};

const listMockRecords = (userId: string) =>
  Array.from(getMockStore().meetingHistoryByGuild.values())
    .flatMap((meetings) => meetings)
    .flatMap((meeting) => [
      ...buildMeetingUserIndexRecords(meeting),
      ...buildGuildShareIndexRecords(meeting),
    ])
    .filter((record) => record.userId === userId);

const mockRepository: MeetingUserIndexRepository = {
  async existsStrong(key) {
    return listMockRecords(key.userId).some(
      (record) => record.userTimestamp === key.userTimestamp,
    );
  },
  async listByPrincipalTimestampPage(principal, options) {
    options.signal?.throwIfAborted();
    if (!Number.isInteger(options.limit) || options.limit <= 0)
      throw new Error("Page limit must be a positive integer");
    const records = listMockRecords(principal)
      .filter(
        (record) =>
          record.timestamp >= options.startTimestamp &&
          record.timestamp <= options.endTimestamp,
      )
      .sort((a, b) => b.userTimestamp.localeCompare(a.userTimestamp));
    const cursorKey = options.cursor?.userTimestamp?.S;
    const remaining = cursorKey
      ? records.filter(
          (record) => record.userTimestamp.localeCompare(cursorKey) < 0,
        )
      : records;
    const items = remaining.slice(0, options.limit).map((record) => ({
      record,
      cursorAfter: marshall({
        userId: record.userId,
        userTimestamp: record.userTimestamp,
      }),
    }));
    return {
      items,
      nextCursor:
        items.length < remaining.length ? items.at(-1)?.cursorAfter : undefined,
    };
  },
  async write(records) {
    for (const record of records) {
      if (record.accessReason === "guild_share") {
        if (!record.userId.startsWith("GUILD_SHARE#"))
          throw new Error("Invalid guild share principal");
      } else {
        assertRawMeetingIndexUserId(record.userId);
      }
    }
  },
  async delete() {},
  async listByUserTimestampRange(userId, startTimestamp, endTimestamp, limit) {
    assertRawMeetingIndexUserId(userId);
    return listMockRecords(userId)
      .filter(
        (record) =>
          record.timestamp >= startTimestamp &&
          record.timestamp <= endTimestamp,
      )
      .sort((a, b) => b.userTimestamp.localeCompare(a.userTimestamp))
      .slice(0, limit);
  },
};

export function getMeetingUserIndexRepository(): MeetingUserIndexRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
