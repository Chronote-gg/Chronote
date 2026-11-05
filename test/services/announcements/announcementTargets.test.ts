import { describe, expect, it } from "@jest/globals";
import { resolveAnnouncementTarget } from "../../../src/services/announcements/announcementTargets";
import type { GuildSnapshot } from "../../../src/services/announcements/announcementTypes";
import type {
  DiscordChannel,
  DiscordPermissionOverwrite,
} from "../../../src/repositories/types";

const GUILD_ID = "100000000000000001";
const BOT_USER_ID = "100000000000000002";
const BOT_ROLE_ID = "100000000000000003";
const OWNER_ID = "100000000000000004";
const UPDATES_CHANNEL_ID = "100000000000000011";
const NOTES_CHANNEL_ID = "100000000000000012";
const SYSTEM_CHANNEL_ID = "100000000000000013";
const GUILD_NAME = "Example Server";

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const POSTING_PERMISSIONS = VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS;

const GUILD_TEXT = 0;
const GUILD_VOICE = 2;
const GUILD_ANNOUNCEMENT = 5;
const PUBLIC_THREAD = 11;
const GUILD_FORUM = 15;

const channel = (
  id: string,
  options: { type?: number; overwrites?: DiscordPermissionOverwrite[] } = {},
): DiscordChannel => ({
  id,
  name: `channel-${id.slice(-2)}`,
  type: options.type ?? GUILD_TEXT,
  permission_overwrites: options.overwrites ?? [],
});

const denyBotRole = (deny: bigint): DiscordPermissionOverwrite => ({
  id: BOT_ROLE_ID,
  type: 0,
  allow: "0",
  deny: deny.toString(),
});

const snapshot = (overrides: Partial<GuildSnapshot> = {}): GuildSnapshot => ({
  guildId: GUILD_ID,
  guildName: GUILD_NAME,
  ownerId: OWNER_ID,
  roles: [
    { id: GUILD_ID, permissions: "0" },
    { id: BOT_ROLE_ID, permissions: POSTING_PERMISSIONS.toString() },
  ],
  botRoleIds: [BOT_ROLE_ID],
  publicUpdatesChannelId: UPDATES_CHANNEL_ID,
  systemChannelId: SYSTEM_CHANNEL_ID,
  notesChannelId: NOTES_CHANNEL_ID,
  channels: [
    channel(UPDATES_CHANNEL_ID),
    channel(NOTES_CHANNEL_ID),
    channel(SYSTEM_CHANNEL_ID),
  ],
  ...overrides,
});

const resolve = (guild: GuildSnapshot, optedOut = false) =>
  resolveAnnouncementTarget(guild, BOT_USER_ID, optedOut);

describe("resolveAnnouncementTarget", () => {
  it("skips an opted-out server without inspecting its channels", () => {
    const guild = snapshot();
    Object.defineProperty(guild, "channels", {
      get: () => {
        throw new Error("channels must not be read for an opted-out server");
      },
    });

    expect(resolve(guild, true)).toEqual({
      kind: "skip",
      reason: "opted_out",
      rejected: [],
    });
  });

  it("targets a postable community updates channel", () => {
    expect(resolve(snapshot())).toEqual({
      kind: "target",
      channelId: UPDATES_CHANNEL_ID,
      channelSource: "public_updates",
      rejected: [],
    });
  });

  it("accepts an announcement channel as the updates channel", () => {
    const guild = snapshot({
      channels: [channel(UPDATES_CHANNEL_ID, { type: GUILD_ANNOUNCEMENT })],
    });

    expect(resolve(guild)).toMatchObject({
      kind: "target",
      channelId: UPDATES_CHANNEL_ID,
    });
  });

  it("targets the notes channel when there is no updates channel", () => {
    expect(resolve(snapshot({ publicUpdatesChannelId: null }))).toEqual({
      kind: "target",
      channelId: NOTES_CHANNEL_ID,
      channelSource: "notes",
      rejected: [],
    });
  });

  it("falls back to the system channel when notes is unset", () => {
    const guild = snapshot({
      publicUpdatesChannelId: null,
      notesChannelId: null,
    });

    expect(resolve(guild)).toEqual({
      kind: "target",
      channelId: SYSTEM_CHANNEL_ID,
      channelSource: "system",
      rejected: [],
    });
  });

  it("asks for an owner DM when the updates channel exists but is unpostable", () => {
    const guild = snapshot({
      channels: [
        channel(UPDATES_CHANNEL_ID, { overwrites: [denyBotRole(EMBED_LINKS)] }),
        channel(NOTES_CHANNEL_ID),
        channel(SYSTEM_CHANNEL_ID),
      ],
    });

    expect(resolve(guild)).toEqual({
      kind: "owner_dm",
      ownerId: OWNER_ID,
      guildName: GUILD_NAME,
      updatesChannelId: UPDATES_CHANNEL_ID,
      missing: ["EmbedLinks"],
      rejected: [
        {
          source: "public_updates",
          channelId: UPDATES_CHANNEL_ID,
          problem: "missing_permissions",
          missing: ["EmbedLinks"],
        },
      ],
    });
  });

  it("skips an opted-out server even when its updates channel is unpostable", () => {
    const guild = snapshot({
      channels: [
        channel(UPDATES_CHANNEL_ID, { overwrites: [denyBotRole(EMBED_LINKS)] }),
      ],
    });

    expect(resolve(guild, true)).toEqual({
      kind: "skip",
      reason: "opted_out",
      rejected: [],
    });
  });

  it("treats an updates channel missing from the channel list as absent", () => {
    const guild = snapshot({
      channels: [channel(NOTES_CHANNEL_ID), channel(SYSTEM_CHANNEL_ID)],
    });

    expect(resolve(guild)).toEqual({
      kind: "target",
      channelId: NOTES_CHANNEL_ID,
      channelSource: "notes",
      rejected: [
        {
          source: "public_updates",
          channelId: UPDATES_CHANNEL_ID,
          problem: "missing",
        },
      ],
    });
  });

  it.each([
    ["thread", PUBLIC_THREAD],
    ["forum", GUILD_FORUM],
    ["voice", GUILD_VOICE],
  ])(
    "treats a %s updates channel as absent and falls through to notes",
    (_label, type) => {
      const guild = snapshot({
        channels: [
          channel(UPDATES_CHANNEL_ID, { type }),
          channel(NOTES_CHANNEL_ID),
        ],
      });

      expect(resolve(guild)).toEqual({
        kind: "target",
        channelId: NOTES_CHANNEL_ID,
        channelSource: "notes",
        rejected: [
          {
            source: "public_updates",
            channelId: UPDATES_CHANNEL_ID,
            problem: "not_text",
          },
        ],
      });
    },
  );

  it("marks a system channel that repeats the notes channel as a duplicate", () => {
    const guild = snapshot({
      publicUpdatesChannelId: null,
      systemChannelId: NOTES_CHANNEL_ID,
      channels: [
        channel(NOTES_CHANNEL_ID, { overwrites: [denyBotRole(VIEW_CHANNEL)] }),
      ],
    });

    expect(resolve(guild).rejected).toEqual([
      {
        source: "notes",
        channelId: NOTES_CHANNEL_ID,
        problem: "missing_permissions",
        missing: ["ViewChannel"],
      },
      {
        source: "system",
        channelId: NOTES_CHANNEL_ID,
        problem: "duplicate",
      },
    ]);
  });

  it("skips no_channel when no candidate channel is set", () => {
    const guild = snapshot({
      publicUpdatesChannelId: null,
      notesChannelId: null,
      systemChannelId: null,
    });

    expect(resolve(guild)).toEqual({
      kind: "skip",
      reason: "no_channel",
      rejected: [],
    });
  });

  it("skips no_channel when every candidate is missing or not text", () => {
    const guild = snapshot({
      publicUpdatesChannelId: null,
      channels: [channel(SYSTEM_CHANNEL_ID, { type: GUILD_VOICE })],
    });

    expect(resolve(guild)).toEqual({
      kind: "skip",
      reason: "no_channel",
      rejected: [
        { source: "notes", channelId: NOTES_CHANNEL_ID, problem: "missing" },
        {
          source: "system",
          channelId: SYSTEM_CHANNEL_ID,
          problem: "not_text",
        },
      ],
    });
  });

  it("skips missing_permissions listing each unpostable fallback", () => {
    const guild = snapshot({
      publicUpdatesChannelId: null,
      roles: [{ id: GUILD_ID, permissions: "0" }],
    });
    const missing = ["ViewChannel", "SendMessages", "EmbedLinks"];

    expect(resolve(guild)).toEqual({
      kind: "skip",
      reason: "missing_permissions",
      rejected: [
        {
          source: "notes",
          channelId: NOTES_CHANNEL_ID,
          problem: "missing_permissions",
          missing,
        },
        {
          source: "system",
          channelId: SYSTEM_CHANNEL_ID,
          problem: "missing_permissions",
          missing,
        },
      ],
    });
  });

  it("lets Administrator post through a denying overwrite", () => {
    const guild = snapshot({
      roles: [
        { id: GUILD_ID, permissions: "0" },
        { id: BOT_ROLE_ID, permissions: ADMINISTRATOR.toString() },
      ],
      channels: [
        channel(UPDATES_CHANNEL_ID, {
          overwrites: [denyBotRole(POSTING_PERMISSIONS)],
        }),
      ],
    });

    expect(resolve(guild)).toMatchObject({
      kind: "target",
      channelId: UPDATES_CHANNEL_ID,
      channelSource: "public_updates",
    });
  });
});
