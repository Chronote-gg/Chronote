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

  test("escapes Markdown syntax in a role name when the target is Markdown", () => {
    const result = replaceDiscordMentionsWithDisplayNames(
      `<@&${ROLE_ID}> owns it.`,
      participants,
      new Map([[ROLE_ID, "[Support](https://example.invalid)"]]),
      { forMarkdown: true },
    );

    expect(result).toBe(
      "@\\[Support\\]\\(https\\://example.invalid\\) owns it.",
    );
    expect(result).not.toContain("](");
  });

  test("escapes Markdown syntax in a member name when the target is Markdown", () => {
    expect(
      replaceDiscordMentionsWithDisplayNames(
        `<@${USER_ID}> spoke.`,
        new Map([
          [USER_ID, { id: USER_ID, username: "u", displayName: "a*b*c" }],
        ]),
        new Map(),
        { forMarkdown: true },
      ),
    ).toBe("@a\\*b\\*c spoke.");
  });

  test("neutralizes bare URL names that remark-gfm would autolink", () => {
    const asMarkdown = (roleName: string) =>
      replaceDiscordMentionsWithDisplayNames(
        `<@&${ROLE_ID}>`,
        participants,
        new Map([[ROLE_ID, roleName]]),
        { forMarkdown: true },
      );

    expect(asMarkdown("https://example.invalid")).not.toContain("https://");
    expect(asMarkdown("www.example.invalid")).not.toContain("www.");
  });

  test("does not break an ordinary name containing a period", () => {
    expect(
      replaceDiscordMentionsWithDisplayNames(
        `<@&${ROLE_ID}>`,
        participants,
        new Map([[ROLE_ID, "Dr. Smith"]]),
        { forMarkdown: true },
      ),
    ).toBe("@Dr. Smith");
  });

  test("leaves names verbatim for plain-text consumers", () => {
    // Timeline text and titles are rendered as plain React text, so escaping
    // there would surface visible backslashes.
    expect(
      replaceDiscordMentionsWithDisplayNames(
        `<@&${ROLE_ID}> owns it.`,
        participants,
        new Map([[ROLE_ID, "Ops_Team"]]),
      ),
    ).toBe("@Ops_Team owns it.");
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
      // Ascending position, matching that Discord's role cache is not ordered
      // by position, so the cap has to sort before slicing.
      roles: { cache: roleIds.map((id, index) => ({ id, position: index })) },
    }) as unknown as GuildMember;

  test("captures role ids and drops @everyone", () => {
    expect(fromMember(buildMember([GUILD_ID, ROLE_ID])).roleIds).toEqual([
      ROLE_ID,
    ]);
  });

  test("omits roleIds entirely when a member holds only @everyone", () => {
    expect(fromMember(buildMember([GUILD_ID])).roleIds).toBeUndefined();
  });

  test("caps snapshotted roles, keeping the highest positions", () => {
    // Ascending position, so the cap must keep the tail, not the head.
    const manyRoles = Array.from(
      { length: 250 },
      (_, index) => `3000000000000000${String(index).padStart(2, "0")}`,
    );

    const roleIds = fromMember(buildMember(manyRoles)).roleIds ?? [];

    expect(roleIds).toHaveLength(40);
    expect(roleIds[0]).toBe(manyRoles[manyRoles.length - 1]);
    expect(roleIds).not.toContain(manyRoles[0]);
  });
});
