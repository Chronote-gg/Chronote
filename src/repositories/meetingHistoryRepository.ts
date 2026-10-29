import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  MeetingBrowsePageOptions,
  MeetingBrowsePage,
} from "../types/meetingBrowse";
import {
  inventoryGuildShareIndexMetadataPage,
  getGuildShareIndexMetadataStrong,
  getDeploymentControlRepository,
  getMeetingUpdateDeliveryRepository,
} from "../db";
import type { MeetingUpdateDeliveryRepository } from "./meetingUpdateDeliveryRepository";
import { config } from "../services/configService";
import {
  getMeetingHistory as getMeetingHistoryRecord,
  getMeetingsForGuildInRange,
  getMeetingHistoryTimestampPage,
  getRecentMeetingsForChannel,
  getRecentMeetingsForGuild,
  updateMeetingArchive,
  updateMeetingAccessGrants,
  updateMeetingStatus,
  updateMeetingTags,
  writeMeetingHistory,
} from "../db";
import type { MeetingHistory, MeetingAccessGrant } from "../types/db";
import { MEETING_STATUS, type MeetingStatus } from "../types/meetingLifecycle";

import { getMockStore } from "./mockStore";

import type { HistoryTransition } from "../types/deploymentControl";

export type MeetingHistoryRepository = Pick<
  MeetingUpdateDeliveryRepository,
  "getStrong" | "updateContentAndDelivery"
> & {
  inventoryGuildShareMetadataPage: typeof inventoryGuildShareIndexMetadataPage;
  getGuildShareMetadataStrong: typeof getGuildShareIndexMetadataStrong;
  listByGuildTimestampPage: (
    guildId: string,
    options: MeetingBrowsePageOptions,
  ) => Promise<MeetingBrowsePage<MeetingHistory>>;
  transitionOwned: (input: HistoryTransition) => Promise<"applied" | "stale">;
  getOwned: (
    key: HistoryTransition["key"],
  ) => Promise<MeetingHistory | undefined>;
  write: (history: MeetingHistory) => Promise<void>;
  get: (
    guildId: string,
    channelIdTimestamp: string,
  ) => Promise<MeetingHistory | undefined>;
  listRecentByGuild: (
    guildId: string,
    limit?: number,
    options?: {
      archivedOnly?: boolean;
      includeArchived?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<MeetingHistory[]>;
  listByGuildTimestampRange: (
    guildId: string,
    startTimestamp: string,
    endTimestamp: string,
    limit?: number,
    signal?: AbortSignal,
  ) => Promise<MeetingHistory[]>;
  listRecentByChannel: (
    guildId: string,
    channelId: string,
    limit?: number,
    options?: {
      archivedOnly?: boolean;
      includeArchived?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<MeetingHistory[]>;
  updateStatus: (
    guildId: string,
    channelIdTimestamp: string,
    status: MeetingStatus,
  ) => Promise<void>;
  updateArchive: (params: {
    guildId: string;
    channelId_timestamp: string;
    archived: boolean;
    archivedByUserId: string;
  }) => Promise<boolean>;
  updateTags: (
    guildId: string,
    channelIdTimestamp: string,
    tags?: string[],
  ) => Promise<void>;
  updateAccessGrants: (params: {
    guildId: string;
    channelId_timestamp: string;
    accessGrants: MeetingAccessGrant[];
  }) => Promise<boolean>;
};

const filterArchivedMeetings = (
  meetings: MeetingHistory[],
  options?: { archivedOnly?: boolean; includeArchived?: boolean },
) => {
  if (options?.archivedOnly) {
    return meetings.filter((meeting) => Boolean(meeting.archivedAt));
  }
  if (options?.includeArchived) {
    return meetings;
  }
  return meetings.filter((meeting) => !meeting.archivedAt);
};

const ownedOperations = {
  getStrong: (
    ...args: Parameters<MeetingUpdateDeliveryRepository["getStrong"]>
  ) => getMeetingUpdateDeliveryRepository().getStrong(...args),
  updateContentAndDelivery: (
    ...args: Parameters<
      MeetingUpdateDeliveryRepository["updateContentAndDelivery"]
    >
  ) => getMeetingUpdateDeliveryRepository().updateContentAndDelivery(...args),
  transitionOwned: (input: HistoryTransition) =>
    getDeploymentControlRepository().transitionMeetingHistory(input),
  getOwned: (key: HistoryTransition["key"]) =>
    getDeploymentControlRepository().getMeetingHistory(key),
};
const realRepository: MeetingHistoryRepository = {
  inventoryGuildShareMetadataPage: inventoryGuildShareIndexMetadataPage,
  getGuildShareMetadataStrong: getGuildShareIndexMetadataStrong,
  ...ownedOperations,
  listByGuildTimestampPage: getMeetingHistoryTimestampPage,
  write: writeMeetingHistory,
  get: getMeetingHistoryRecord,
  listRecentByGuild: async (guildId, limit, options) => {
    const meetings = await getRecentMeetingsForGuild(
      guildId,
      limit,
      options?.signal,
    );
    const active = meetings.filter(
      (meeting) => meeting.status !== MEETING_STATUS.CANCELLED,
    );
    return filterArchivedMeetings(active, options);
  },
  listByGuildTimestampRange: async (
    guildId,
    startTimestamp,
    endTimestamp,
    limit,
    signal,
  ) => {
    const meetings = await getMeetingsForGuildInRange(
      guildId,
      startTimestamp,
      endTimestamp,
      limit,
      signal,
    );
    return meetings.filter(
      (meeting) => meeting.status !== MEETING_STATUS.CANCELLED,
    );
  },
  listRecentByChannel: async (guildId, channelId, limit, options) => {
    const meetings = await getRecentMeetingsForChannel(
      guildId,
      channelId,
      limit,
      options?.signal,
    );
    const active = meetings.filter(
      (meeting) => meeting.status !== MEETING_STATUS.CANCELLED,
    );
    return filterArchivedMeetings(active, options);
  },
  updateStatus: updateMeetingStatus,
  updateArchive: updateMeetingArchive,
  updateTags: updateMeetingTags,
  updateAccessGrants: updateMeetingAccessGrants,
};

const mockRepository: MeetingHistoryRepository = {
  async inventoryGuildShareMetadataPage() {
    throw new Error(
      "Historical repair requires an explicit real repository target",
    );
  },
  async getGuildShareMetadataStrong() {
    throw new Error(
      "Historical repair requires an explicit real repository target",
    );
  },
  ...ownedOperations,
  async listByGuildTimestampPage(guildId, options) {
    options.signal?.throwIfAborted();
    if (!Number.isInteger(options.limit) || options.limit <= 0)
      throw new Error("Page limit must be a positive integer");
    const records = [
      ...(getMockStore().meetingHistoryByGuild.get(guildId) ?? []),
    ]
      .filter(
        (record) =>
          record.timestamp >= options.startTimestamp &&
          record.timestamp <= options.endTimestamp,
      )
      .sort(
        (a, b) =>
          b.timestamp.localeCompare(a.timestamp) ||
          b.channelId_timestamp.localeCompare(a.channelId_timestamp),
      );
    const cursorTimestamp = options.cursor?.timestamp?.S;
    const cursorKey = options.cursor?.channelId_timestamp?.S;
    const remaining =
      cursorTimestamp && cursorKey
        ? records.filter(
            (record) =>
              record.timestamp.localeCompare(cursorTimestamp) < 0 ||
              (record.timestamp === cursorTimestamp &&
                record.channelId_timestamp.localeCompare(cursorKey) < 0),
          )
        : records;
    const items = remaining.slice(0, options.limit).map((record) => ({
      record,
      cursorAfter: marshall({
        guildId: record.guildId,
        timestamp: record.timestamp,
        channelId_timestamp: record.channelId_timestamp,
      }),
    }));
    return {
      items,
      nextCursor:
        items.length < remaining.length ? items.at(-1)?.cursorAfter : undefined,
    };
  },
  async write(history) {
    const store = getMockStore();
    const existing = store.meetingHistoryByGuild.get(history.guildId) ?? [];
    const idx = existing.findIndex(
      (item) => item.channelId_timestamp === history.channelId_timestamp,
    );
    if (idx >= 0) {
      existing[idx] = history;
    } else {
      existing.push(history);
    }
    store.meetingHistoryByGuild.set(history.guildId, existing);
  },
  async get(guildId, channelIdTimestamp) {
    const items = getMockStore().meetingHistoryByGuild.get(guildId) ?? [];
    return items.find(
      (item) => item.channelId_timestamp === channelIdTimestamp,
    );
  },
  async listRecentByGuild(guildId, limit = 10, options) {
    options?.signal?.throwIfAborted();
    const items = getMockStore().meetingHistoryByGuild.get(guildId) ?? [];
    const active = [...items].filter(
      (item) => item.status !== MEETING_STATUS.CANCELLED,
    );
    return filterArchivedMeetings(active, options)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  },
  async listRecentByChannel(guildId, channelId, limit = 5, options) {
    options?.signal?.throwIfAborted();
    const items = getMockStore().meetingHistoryByGuild.get(guildId) ?? [];
    const active = items
      .filter((item) => item.channelId === channelId)
      .filter((item) => item.status !== MEETING_STATUS.CANCELLED);
    return filterArchivedMeetings(active, options)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  },
  async listByGuildTimestampRange(
    guildId,
    startTimestamp,
    endTimestamp,
    limit,
  ) {
    const items = getMockStore().meetingHistoryByGuild.get(guildId) ?? [];
    return items
      .filter((item) => {
        if (!item.timestamp) return false;
        if (item.status === MEETING_STATUS.CANCELLED) return false;
        return (
          item.timestamp >= startTimestamp && item.timestamp <= endTimestamp
        );
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  },
  async updateTags(guildId, channelIdTimestamp, tags) {
    const items = getMockStore().meetingHistoryByGuild.get(guildId) ?? [];
    const idx = items.findIndex(
      (item) => item.channelId_timestamp === channelIdTimestamp,
    );
    if (idx === -1) return;
    items[idx] = { ...items[idx], tags: tags ?? [] };
    getMockStore().meetingHistoryByGuild.set(guildId, items);
  },
  async updateStatus(guildId, channelIdTimestamp, status) {
    const items = getMockStore().meetingHistoryByGuild.get(guildId) ?? [];
    const idx = items.findIndex(
      (item) => item.channelId_timestamp === channelIdTimestamp,
    );
    if (idx === -1) return;
    items[idx] = {
      ...items[idx],
      status,
      updatedAt: new Date().toISOString(),
    };
    getMockStore().meetingHistoryByGuild.set(guildId, items);
  },
  async updateArchive({
    guildId,
    channelId_timestamp,
    archived,
    archivedByUserId,
  }) {
    const items = getMockStore().meetingHistoryByGuild.get(guildId) ?? [];
    const idx = items.findIndex(
      (item) => item.channelId_timestamp === channelId_timestamp,
    );
    if (idx === -1) return false;
    const now = new Date().toISOString();
    const existing = items[idx];
    items[idx] = {
      ...existing,
      archivedAt: archived ? now : undefined,
      archivedByUserId: archived ? archivedByUserId : undefined,
      updatedAt: now,
    };
    getMockStore().meetingHistoryByGuild.set(guildId, items);
    return true;
  },
  async updateAccessGrants(params) {
    const items =
      getMockStore().meetingHistoryByGuild.get(params.guildId) ?? [];
    const idx = items.findIndex(
      (item) => item.channelId_timestamp === params.channelId_timestamp,
    );
    if (idx === -1) return false;
    items[idx] = {
      ...items[idx],
      accessGrants: params.accessGrants,
      updatedAt: new Date().toISOString(),
    };
    getMockStore().meetingHistoryByGuild.set(params.guildId, items);
    return true;
  },
};

export function getMeetingHistoryRepository(): MeetingHistoryRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
