import { describe, expect, it, jest } from "@jest/globals";
import {
  getGuildMemberCached,
  listGuildChannelsCached,
  listGuildRolesCached,
} from "../../src/services/discordCacheService";
import {
  computeChannelPermissions,
  ensureUserCanViewChannel,
} from "../../src/services/discordPermissionsService";
import type {
  DiscordChannel,
  DiscordPermissionOverwrite,
} from "../../src/repositories/types";

jest.mock("../../src/services/discordCacheService", () => ({
  getGuildMemberCached: jest.fn(),
  listGuildChannelsCached: jest.fn(),
  listGuildRolesCached: jest.fn(),
}));
// The real module loads the app config; these tests never reach Discord.
jest.mock("../../src/services/discordService", () => ({
  isDiscordApiError: () => false,
}));

const GUILD_ID = "100000000000000001";
const MEMBER_ID = "100000000000000002";
const MEMBER_ROLE_ID = "100000000000000003";
const OTHER_ROLE_ID = "100000000000000004";
const CHANNEL_ID = "100000000000000005";
const OTHER_MEMBER_ID = "100000000000000006";

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const ALL_PERMISSIONS = (1n << 64n) - 1n;

const roleOverwrite = (
  id: string,
  bits: { allow?: bigint; deny?: bigint },
): DiscordPermissionOverwrite => ({
  id,
  type: 0,
  allow: (bits.allow ?? 0n).toString(),
  deny: (bits.deny ?? 0n).toString(),
});

const memberOverwrite = (
  id: string,
  bits: { allow?: bigint; deny?: bigint },
): DiscordPermissionOverwrite => ({
  ...roleOverwrite(id, bits),
  type: 1,
});

const compute = (options: {
  everyone?: bigint;
  memberRole?: bigint;
  otherRole?: bigint;
  memberRoleIds?: string[];
  overwrites?: DiscordPermissionOverwrite[];
}) =>
  computeChannelPermissions({
    guildId: GUILD_ID,
    memberId: MEMBER_ID,
    roles: [
      { id: GUILD_ID, permissions: (options.everyone ?? 0n).toString() },
      {
        id: MEMBER_ROLE_ID,
        permissions: (options.memberRole ?? 0n).toString(),
      },
      { id: OTHER_ROLE_ID, permissions: (options.otherRole ?? 0n).toString() },
    ],
    memberRoleIds: options.memberRoleIds ?? [MEMBER_ROLE_ID],
    overwrites: options.overwrites ?? [],
  });

describe("computeChannelPermissions", () => {
  it("grants the @everyone role permissions to a member with no other bits", () => {
    const permissions = compute({ everyone: VIEW_CHANNEL, memberRoleIds: [] });

    expect(permissions & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
    expect(permissions & SEND_MESSAGES).toBe(0n);
  });

  it("adds the bits of each role the member holds", () => {
    const permissions = compute({
      everyone: VIEW_CHANNEL,
      memberRole: SEND_MESSAGES,
    });

    expect(permissions & SEND_MESSAGES).toBe(SEND_MESSAGES);
  });

  it("ignores roles the member does not hold", () => {
    const permissions = compute({ otherRole: SEND_MESSAGES });

    expect(permissions & SEND_MESSAGES).toBe(0n);
  });

  it("removes a bit denied by the channel @everyone overwrite", () => {
    const permissions = compute({
      everyone: VIEW_CHANNEL | EMBED_LINKS,
      overwrites: [roleOverwrite(GUILD_ID, { deny: EMBED_LINKS })],
    });

    expect(permissions & EMBED_LINKS).toBe(0n);
    expect(permissions & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
  });

  it("re-adds a bit through a role overwrite allow after an @everyone deny", () => {
    const permissions = compute({
      everyone: VIEW_CHANNEL,
      overwrites: [
        roleOverwrite(GUILD_ID, { deny: VIEW_CHANNEL }),
        roleOverwrite(MEMBER_ROLE_ID, { allow: VIEW_CHANNEL }),
      ],
    });

    expect(permissions & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
  });

  it("lets the allow win when two of the member's role overwrites conflict", () => {
    const denyFirst = [
      roleOverwrite(MEMBER_ROLE_ID, { deny: SEND_MESSAGES }),
      roleOverwrite(OTHER_ROLE_ID, { allow: SEND_MESSAGES }),
    ];

    for (const overwrites of [denyFirst, [...denyFirst].reverse()]) {
      const permissions = compute({
        everyone: SEND_MESSAGES,
        memberRoleIds: [MEMBER_ROLE_ID, OTHER_ROLE_ID],
        overwrites,
      });
      expect(permissions & SEND_MESSAGES).toBe(SEND_MESSAGES);
    }
  });

  it("lets a member overwrite deny beat a role overwrite allow", () => {
    const permissions = compute({
      overwrites: [
        roleOverwrite(MEMBER_ROLE_ID, { allow: EMBED_LINKS }),
        memberOverwrite(MEMBER_ID, { deny: EMBED_LINKS }),
      ],
    });

    expect(permissions & EMBED_LINKS).toBe(0n);
  });

  it("ignores a member overwrite for someone else", () => {
    const permissions = compute({
      everyone: VIEW_CHANNEL,
      overwrites: [memberOverwrite(OTHER_MEMBER_ID, { deny: VIEW_CHANNEL })],
    });

    expect(permissions & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
  });

  it("returns every bit for an Administrator role even with a deny overwrite", () => {
    const permissions = compute({
      memberRole: ADMINISTRATOR,
      overwrites: [
        roleOverwrite(GUILD_ID, { deny: VIEW_CHANNEL }),
        memberOverwrite(MEMBER_ID, { deny: VIEW_CHANNEL | EMBED_LINKS }),
      ],
    });

    expect(permissions).toBe(ALL_PERMISSIONS);
    expect(permissions & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
  });

  it("treats a missing role permission value as no bits", () => {
    const permissions = computeChannelPermissions({
      guildId: GUILD_ID,
      memberId: MEMBER_ID,
      roles: [{ id: GUILD_ID, permissions: null }, { id: MEMBER_ROLE_ID }],
      memberRoleIds: [MEMBER_ROLE_ID],
      overwrites: [],
    });

    expect(permissions).toBe(0n);
  });
});

describe("ensureUserCanViewChannel", () => {
  const mockCachedGuild = (channel: DiscordChannel) => {
    jest.mocked(listGuildChannelsCached).mockResolvedValue([channel]);
    jest.mocked(listGuildRolesCached).mockResolvedValue([
      {
        id: GUILD_ID,
        name: "@everyone",
        permissions: VIEW_CHANNEL.toString(),
      },
      { id: MEMBER_ROLE_ID, name: "Member", permissions: "0" },
    ]);
    jest.mocked(getGuildMemberCached).mockResolvedValue({
      user: { id: MEMBER_ID, username: "member" },
      roles: [MEMBER_ROLE_ID],
    });
  };

  it("lets a role overwrite re-allow a channel the @everyone overwrite hides", async () => {
    mockCachedGuild({
      id: CHANNEL_ID,
      name: "general",
      type: 0,
      permission_overwrites: [
        { id: GUILD_ID, type: 0, allow: "0", deny: VIEW_CHANNEL.toString() },
        {
          id: MEMBER_ROLE_ID,
          type: 0,
          allow: VIEW_CHANNEL.toString(),
          deny: "0",
        },
      ],
    });

    await expect(
      ensureUserCanViewChannel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        userId: MEMBER_ID,
      }),
    ).resolves.toBe(true);
  });

  it("denies when a member overwrite hides the channel", async () => {
    mockCachedGuild({
      id: CHANNEL_ID,
      name: "general",
      type: 0,
      permission_overwrites: [
        { id: MEMBER_ID, type: 1, allow: "0", deny: VIEW_CHANNEL.toString() },
      ],
    });

    await expect(
      ensureUserCanViewChannel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        userId: MEMBER_ID,
      }),
    ).resolves.toBe(false);
  });

  it("denies when the channel is not in the guild", async () => {
    mockCachedGuild({ id: "100000000000000099", name: "other", type: 0 });

    await expect(
      ensureUserCanViewChannel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        userId: MEMBER_ID,
      }),
    ).resolves.toBe(false);
  });
});
