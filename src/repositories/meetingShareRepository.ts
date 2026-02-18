import { config } from "../services/configService";
import {
  deleteMeetingShareByMeetingId,
  deleteMeetingShareByShareId,
  getMeetingShareByMeetingId,
  getMeetingShareByShareId,
  writeMeetingShare,
  writeMeetingShareByMeeting,
} from "../db";
import type {
  MeetingShareByMeetingRecord,
  MeetingShareRecord,
} from "../types/db";
import { getMockStore } from "./mockStore";

export type MeetingShareRepository = {
  getByShareId: (
    guildId: string,
    shareId: string,
  ) => Promise<MeetingShareRecord | undefined>;
  getByMeetingId: (
    guildId: string,
    meetingId: string,
  ) => Promise<MeetingShareByMeetingRecord | undefined>;
  write: (records: {
    share: MeetingShareRecord;
    byMeeting: MeetingShareByMeetingRecord;
  }) => Promise<void>;
  delete: (params: {
    guildId: string;
    meetingId: string;
    shareId: string;
  }) => Promise<void>;
};

const realRepository: MeetingShareRepository = {
  async getByShareId(guildId, shareId) {
    return getMeetingShareByShareId(guildId, shareId);
  },
  async getByMeetingId(guildId, meetingId) {
    return getMeetingShareByMeetingId(guildId, meetingId);
  },
  async write({ share, byMeeting }) {
    await Promise.all([
      writeMeetingShare(share),
      writeMeetingShareByMeeting(byMeeting),
    ]);
  },
  async delete({ guildId, meetingId, shareId }) {
    await Promise.all([
      deleteMeetingShareByShareId(guildId, shareId),
      deleteMeetingShareByMeetingId(guildId, meetingId),
    ]);
  },
};

const buildShareKey = (guildId: string, shareId: string) =>
  `${guildId}#${shareId}`;

const buildMeetingKey = (guildId: string, meetingId: string) =>
  `${guildId}#${meetingId}`;

const mockRepository: MeetingShareRepository = {
  async getByShareId(guildId, shareId) {
    const key = buildShareKey(guildId, shareId);
    return getMockStore().meetingSharesByShareKey.get(key);
  },
  async getByMeetingId(guildId, meetingId) {
    const key = buildMeetingKey(guildId, meetingId);
    return getMockStore().meetingSharesByMeetingKey.get(key);
  },
  async write({ share, byMeeting }) {
    const store = getMockStore();
    store.meetingSharesByShareKey.set(
      buildShareKey(share.guildId, share.shareId),
      share,
    );
    store.meetingSharesByMeetingKey.set(
      buildMeetingKey(byMeeting.guildId, byMeeting.meetingId),
      byMeeting,
    );
  },
  async delete({ guildId, meetingId, shareId }) {
    const store = getMockStore();
    store.meetingSharesByShareKey.delete(buildShareKey(guildId, shareId));
    store.meetingSharesByMeetingKey.delete(buildMeetingKey(guildId, meetingId));
  },
};

export function getMeetingShareRepository(): MeetingShareRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
