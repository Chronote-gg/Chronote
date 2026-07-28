import { describe, expect, test } from "@jest/globals";
import type { GuildMember } from "discord.js";
import type { Participant } from "../../types/participants";
import {
  formatRoleMention,
  formatUserMention,
  fromMember,
  replaceDiscordMentionsWithDisplayNames,
} from "../participants";

const GUILD_ID = "100000000000000001";
const USER_ID = "200000000000000001";
const ROLE_ID = "300000000000000001";

const participants = new Map<string, Participant>([
  [USER_ID, { id: USER_ID, username: "user-a", serverNickname: "User A" }],
]);
const roleNames = new Map([[ROLE_ID, "Design"]]);

describe("mention formatting", () => {
  test("builds user and role mention strings", () => {
    expect(formatUserMention(USER_ID)).toBe(`<@${USER_ID}>`);
    expect(formatRoleMention(ROLE_ID)).toBe(`<@&${ROLE_ID}>`);
  });
});

describe("replaceDiscordMentionsWithDisplayNames", () => {
  test("resolves user and role mentions in one pass", () => {
    const result = replaceDiscordMentionsWithDisplayNames(
      `<@${USER_ID}> and <@&${ROLE_ID}> both act.`,
      participants,
      roleNames,
    );

    expect(result).toBe("@User A and @Design both act.");
  });

  test("resolves legacy nickname mentions", () => {
    expect(
      replaceDiscordMentionsWithDisplayNames(
        `<@!${USER_ID}> spoke.`,
        participants,
      ),
    ).toBe("@User A spoke.");
  });

  test("leaves role mentions raw when no role names are supplied", () => {
    expect(
      replaceDiscordMentionsWithDisplayNames(
        `<@&${ROLE_ID}> owns it.`,
        participants,
      ),
    ).toBe(`<@&${ROLE_ID}> owns it.`);
  });

  test("does not double prefix names that already start with @", () => {
    const result = replaceDiscordMentionsWithDisplayNames(
      `<@&${ROLE_ID}>`,
      participants,
      new Map([[ROLE_ID, "@Design"]]),
    );

    expect(result).toBe("@Design");
  });

  test("returns empty text unchanged", () => {
    expect(replaceDiscordMentionsWithDisplayNames("", participants)).toBe("");
  });

  test("escapes Markdown syntax in a role name", () => {
    const result = replaceDiscordMentionsWithDisplayNames(
      `<@&${ROLE_ID}> owns it.`,
      participants,
      new Map([[ROLE_ID, "[Support](https://example.invalid)"]]),
    );

    expect(result).toBe("@\\[Support\\]\\(https://example.invalid\\) owns it.");
    expect(result).not.toContain("](");
  });

  test("escapes Markdown syntax in a member name", () => {
    expect(
      replaceDiscordMentionsWithDisplayNames(
        `<@${USER_ID}> spoke.`,
        new Map([
          [USER_ID, { id: USER_ID, username: "u", displayName: "a*b*c" }],
        ]),
      ),
    ).toBe("@a\\*b\\*c spoke.");
  });

  test("leaves ordinary punctuation in names alone", () => {
    expect(
      replaceDiscordMentionsWithDisplayNames(
        `<@&${ROLE_ID}>`,
        participants,
        new Map([[ROLE_ID, "Dr. Jane-Doe"]]),
      ),
    ).toBe("@Dr. Jane-Doe");
  });
});

describe("fromMember", () => {
  const buildMember = (roleIds: string[]): GuildMember =>
    ({
      user: {
        id: USER_ID,
        username: "user-a",
        globalName: "User A",
        tag: "user-a",
      },
      nickname: "Nick",
      guild: { id: GUILD_ID },
      roles: { cache: roleIds.map((id) => ({ id })) },
    }) as unknown as GuildMember;

  test("captures role ids and drops @everyone", () => {
    expect(fromMember(buildMember([GUILD_ID, ROLE_ID])).roleIds).toEqual([
      ROLE_ID,
    ]);
  });

  test("omits roleIds entirely when a member holds only @everyone", () => {
    expect(fromMember(buildMember([GUILD_ID])).roleIds).toBeUndefined();
  });

  test("caps snapshotted roles so one member cannot bloat the history item", () => {
    const manyRoles = Array.from(
      { length: 250 },
      (_, index) => `3000000000000000${String(index).padStart(2, "0")}`,
    );

    const roleIds = fromMember(buildMember(manyRoles)).roleIds ?? [];

    expect(roleIds).toHaveLength(40);
    expect(roleIds[0]).toBe(manyRoles[0]);
  });
});
