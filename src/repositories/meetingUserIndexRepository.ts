import { config } from "../services/configService";
import {
  deleteMeetingUserIndexRecords,
  getMeetingUserIndexRecordsForUserInRange,
  writeMeetingUserIndexRecords,
} from "../db";
import type { MeetingUserIndexRecord } from "../types/db";
import { buildMeetingUserIndexRecords } from "../utils/meetingUserIndex";
import { getMockStore } from "./mockStore";

export type MeetingUserIndexRepository = {
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
  write: writeMeetingUserIndexRecords,
  delete: deleteMeetingUserIndexRecords,
  listByUserTimestampRange: getMeetingUserIndexRecordsForUserInRange,
};

const listMockRecords = (userId: string) =>
  Array.from(getMockStore().meetingHistoryByGuild.values())
    .flatMap((meetings) => meetings)
    .flatMap(buildMeetingUserIndexRecords)
    .filter((record) => record.userId === userId);

const mockRepository: MeetingUserIndexRepository = {
  async write() {},
  async delete() {},
  async listByUserTimestampRange(userId, startTimestamp, endTimestamp, limit) {
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
