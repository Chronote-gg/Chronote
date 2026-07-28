import { describe, expect, jest, test } from "@jest/globals";
import type { MeetingHistory } from "../../types/db";

const GUILD_ID = "100000000000000001";
const USER_ID = "200000000000000001";
const ROLE_ID = "300000000000000001";

const buildHistory = (
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory =>
  ({
    guildId: GUILD_ID,
    participants: [{ id: USER_ID, username: "user-a", displayName: "User A" }],
    ...overrides,
  }) as MeetingHistory;

const loadModule = async (
  listGuildRolesCached: jest.Mock<(guildId: string) => Promise<unknown[]>>,
) => {
  jest.resetModules();
  jest.doMock("../discordCacheService", () => ({ listGuildRolesCached }));
  return await import("../meetingMentionService");
};

const rolesOk = () =>
  jest
    .fn<(guildId: string) => Promise<unknown[]>>()
    .mockResolvedValue([{ id: ROLE_ID, name: "Design", permissions: "0" }]);

describe("createMeetingMentionReplacer", () => {
  test("resolves user and role mentions to readable names", async () => {
    const { createMeetingMentionReplacer } = await loadModule(rolesOk());
    const resolve = await createMeetingMentionReplacer(buildHistory());

    expect(resolve(`<@${USER_ID}> and <@&${ROLE_ID}> own this.`)).toBe(
      "@User A and @Design own this.",
    );
  });

  test("leaves unknown ids as raw mentions", async () => {
    const { createMeetingMentionReplacer } = await loadModule(rolesOk());
    const resolve = await createMeetingMentionReplacer(buildHistory());

    expect(resolve("<@999999999999999999> <@&888888888888888888>")).toBe(
      "<@999999999999999999> <@&888888888888888888>",
    );
  });

  test("skips role lookup for personal meetings", async () => {
    const listGuildRolesCached = rolesOk();
    const { createMeetingMentionReplacer } =
      await loadModule(listGuildRolesCached);

    const resolve = await createMeetingMentionReplacer(
      buildHistory({ ownershipScope: "personal" }),
    );

    expect(listGuildRolesCached).not.toHaveBeenCalled();
    expect(resolve(`<@${USER_ID}> spoke.`)).toBe("@User A spoke.");
  });

  test("degrades to raw role mentions when Discord role lookup fails", async () => {
    const listGuildRolesCached = jest
      .fn<(guildId: string) => Promise<unknown[]>>()
      .mockRejectedValue(new Error("rate limited"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { createMeetingMentionReplacer } =
      await loadModule(listGuildRolesCached);

    const resolve = await createMeetingMentionReplacer(buildHistory());

    expect(resolve(`<@${USER_ID}> and <@&${ROLE_ID}>`)).toBe(
      `@User A and <@&${ROLE_ID}>`,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("reuses prefetched role names without hitting Discord", async () => {
    const listGuildRolesCached = rolesOk();
    const { buildMeetingMentionReplacer } =
      await loadModule(listGuildRolesCached);

    const resolve = buildMeetingMentionReplacer(
      buildHistory(),
      new Map([[GUILD_ID, new Map([[ROLE_ID, "Design"]])]]),
    );

    expect(resolve(`<@&${ROLE_ID}> reviews.`)).toBe("@Design reviews.");
    expect(listGuildRolesCached).not.toHaveBeenCalled();
  });

  test("leaves role mentions raw when a guild is missing from the prefetch", async () => {
    const { buildMeetingMentionReplacer } = await loadModule(rolesOk());

    const resolve = buildMeetingMentionReplacer(buildHistory(), new Map());

    expect(resolve(`<@${USER_ID}> and <@&${ROLE_ID}>`)).toBe(
      `@User A and <@&${ROLE_ID}>`,
    );
  });

  test("ignores roles that have no name", async () => {
    const listGuildRolesCached = jest
      .fn<(guildId: string) => Promise<unknown[]>>()
      .mockResolvedValue([{ id: ROLE_ID, permissions: "0" }]);
    const { createMeetingMentionReplacer } =
      await loadModule(listGuildRolesCached);

    const resolve = await createMeetingMentionReplacer(buildHistory());

    expect(resolve(`<@&${ROLE_ID}>`)).toBe(`<@&${ROLE_ID}>`);
  });
});
