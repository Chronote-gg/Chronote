import { jest } from "@jest/globals";
import type { DiscordChannel } from "../../../src/repositories/types";
import { DiscordMessageHttpError } from "../../../src/services/discordMessageEditor";
import type { AnnouncementDiscordClient } from "../../../src/services/announcements/announcementDiscordClient";
import type {
  AnnouncementDeliveryStore,
  DeliveryRecord,
} from "../../../src/services/announcements/announcementDeliveryStore";
import type {
  AnnouncementScope,
  RunnerDeps,
} from "../../../src/services/announcements/announcementRunner";
import type { Announcement } from "../../../src/services/announcements/announcementTypes";

export const BOT_USER_ID = "100000000000000002";
export const BOT_ROLE_ID = "100000000000000003";
export const OWNER_ID = "100000000000000004";
export const DM_CHANNEL_ID = "100000000000000005";
export const ANNOUNCEMENT_ID = "incident-2026-11-04";
export const PREVIEW_TIME = new Date("2026-11-04T12:00:00.000Z");

const POSTING_PERMISSIONS = (
  (1n << 10n) |
  (1n << 11n) |
  (1n << 14n)
).toString();

/** Fake snowflakes: guild n is 1000000000000001nn, its channels 1000000000000002nn and up. */
export const guildId = (n: number) =>
  `1000000000000001${String(n).padStart(2, "0")}`;
export const updatesChannelId = (n: number) =>
  `1000000000000002${String(n).padStart(2, "0")}`;
export const systemChannelId = (n: number) =>
  `1000000000000003${String(n).padStart(2, "0")}`;

export const scope: AnnouncementScope = {
  accountId: "000000000000",
  region: "us-east-1",
  configTable: "example-config-table",
  deliveryTable: "example-delivery-table",
};

export const announcement: Announcement = {
  id: ANNOUNCEMENT_ID,
  kind: "incident",
  title: "Example notice",
  body: "Example body.",
  fields: [],
};

export type FakeGuild = {
  id: string;
  name: string;
  ownerId: string;
  publicUpdatesChannelId: string | null;
  systemChannelId: string | null;
  notesChannelId: string | null;
  channels: DiscordChannel[];
  roles: { id: string; permissions: string }[];
  optedOut: boolean;
  /** When set, every Discord read for this server fails with this status. */
  readStatus?: number;
};

/** A server whose community updates channel the bot can post in. */
export const fakeGuild = (
  n: number,
  overrides: Partial<FakeGuild> = {},
): FakeGuild => ({
  id: guildId(n),
  name: `Example Server ${n}`,
  ownerId: OWNER_ID,
  publicUpdatesChannelId: updatesChannelId(n),
  systemChannelId: null,
  notesChannelId: null,
  channels: [
    { id: updatesChannelId(n), name: "updates", type: 0 },
    { id: systemChannelId(n), name: "general", type: 0 },
  ],
  roles: [
    { id: guildId(n), permissions: "0" },
    { id: BOT_ROLE_ID, permissions: POSTING_PERMISSIONS },
  ],
  optedOut: false,
  ...overrides,
});

/** Denies one permission bit to the bot role on a channel. */
export const denyOnChannel = (
  guild: FakeGuild,
  channelId: string,
  bit: bigint,
) => {
  const channel = guild.channels.find((entry) => entry.id === channelId);
  if (!channel) throw new Error("no such fake channel");
  channel.permission_overwrites = [
    { id: BOT_ROLE_ID, type: 0, allow: "0", deny: bit.toString() },
  ];
};

export const VIEW_CHANNEL = 1n << 10n;
export const EMBED_LINKS = 1n << 14n;

const createFakeStore = () => {
  const records = new Map<string, DeliveryRecord>();
  const update = (
    guild: string,
    changes: Partial<DeliveryRecord>,
    now: Date,
  ) => {
    const record = records.get(guild);
    if (record?.status !== "pending")
      throw Object.assign(new Error("not pending"), {
        name: "ConditionalCheckFailedException",
      });
    records.set(guild, {
      ...record,
      ...changes,
      updatedAt: now.toISOString(),
    });
  };
  const store = {
    assertTableExists: jest.fn(async () => undefined),
    listForAnnouncement: jest.fn(async (id: string) =>
      [...records.values()].filter((record) => record.announcementId === id),
    ),
    claimPending: jest.fn(
      async (
        record: Parameters<AnnouncementDeliveryStore["claimPending"]>[0],
        { replaceFailed }: { replaceFailed: boolean },
      ) => {
        const existing = records.get(record.guildId);
        if (existing && !(replaceFailed && existing.status === "failed"))
          return "exists" as const;
        records.set(record.guildId, {
          ...record,
          status: "pending",
          updatedAt: record.createdAt,
        });
        return "claimed" as const;
      },
    ),
    markSent: jest.fn(
      async (_id: string, guild: string, messageId: string, now: Date) =>
        update(guild, { status: "sent", messageId }, now),
    ),
    markFailed: jest.fn(
      async (_id: string, guild: string, reason: string, now: Date) =>
        update(guild, { status: "failed", reason }, now),
    ),
  } satisfies AnnouncementDeliveryStore;
  return { store, records };
};

/** In-memory Discord, delivery store and settings over a mutable server list. */
export function createFakes(guilds: FakeGuild[]) {
  const find = (id: string, operation: string) => {
    const guild = guilds.find((entry) => entry.id === id);
    if (!guild) throw new DiscordMessageHttpError(operation, 404);
    if (guild.readStatus !== undefined)
      throw new DiscordMessageHttpError(operation, guild.readStatus);
    return guild;
  };
  const discord = {
    getBotUserId: jest.fn(async () => BOT_USER_ID),
    listBotGuildIds: jest.fn(async () => guilds.map((guild) => guild.id)),
    getGuild: jest.fn(async (id: string) => {
      const guild = find(id, "guild fetch");
      return {
        id: guild.id,
        name: guild.name,
        ownerId: guild.ownerId,
        roles: guild.roles,
        publicUpdatesChannelId: guild.publicUpdatesChannelId,
        systemChannelId: guild.systemChannelId,
      };
    }),
    listGuildChannels: jest.fn(
      async (id: string) => find(id, "guild channel list").channels,
    ),
    getMemberRoleIds: jest.fn(async (id: string) => {
      find(id, "guild member fetch");
      return [BOT_ROLE_ID];
    }),
    openDmChannel: jest.fn<AnnouncementDiscordClient["openDmChannel"]>(
      async () => DM_CHANNEL_ID,
    ),
    createMessage: jest.fn<AnnouncementDiscordClient["createMessage"]>(
      async (channelId) => ({ id: `9${channelId.slice(1)}` }),
    ),
  } satisfies AnnouncementDiscordClient;
  const settings = {
    read: jest.fn(async (id: string) => {
      const guild = guilds.find((entry) => entry.id === id);
      return {
        optedOut: guild?.optedOut ?? false,
        notesChannelId: guild?.notesChannelId ?? null,
      };
    }),
  };
  const sleep = jest.fn<RunnerDeps["sleep"]>(async () => undefined);
  const { store, records } = createFakeStore();
  const deps: RunnerDeps = {
    discord,
    store,
    settings,
    now: () => PREVIEW_TIME,
    sleep,
  };
  return { deps, discord, store, records, settings, sleep };
}
