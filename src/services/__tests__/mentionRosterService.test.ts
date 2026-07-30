import { describe, expect, jest, test } from "@jest/globals";
import type { MeetingHistory } from "../../types/db";

const GUILD_ID = "100000000000000001";
const USER_ID = "200000000000000001";
const ROLE_ID = "300000000000000001";

const buildMeeting = (overrides: Partial<MeetingHistory> = {}) =>
  ({
    guildId: GUILD_ID,
    participants: [
      {
        id: USER_ID,
        username: "user-a",
        displayName: "User A",
        roleIds: [ROLE_ID],
      },
    ],
    ...overrides,
  }) as MeetingHistory;

const loadModule = async (
  listGuildRolesCached: jest.Mock<(guildId: string) => Promise<unknown[]>>,
) => {
  jest.resetModules();
  jest.doMock("../discordCacheService", () => ({ listGuildRolesCached }));
  return await import("../mentionRosterService");
};

const rolesOk = () =>
  jest.fn<(guildId: string) => Promise<unknown[]>>().mockResolvedValue([
    { id: ROLE_ID, name: "Design", permissions: "0" },
    { id: GUILD_ID, name: "@everyone", permissions: "0" },
    { id: "300000000000000009", name: "Bot", permissions: "0", managed: true },
  ]);

describe("buildMentionRosters", () => {
  test("renders both rosters and reports only the ids the model was shown", async () => {
    const { buildMentionRosters } = await loadModule(rolesOk());

    const rosters = await buildMentionRosters(buildMeeting());

    expect(rosters.roles).toContain(`mention: <@&${ROLE_ID}>`);
    expect(rosters.participantRoster).toContain(`mention: <@${USER_ID}>`);
    expect(rosters.allowedUserIds).toEqual([USER_ID]);
    // @everyone and the managed bot role are excluded from what is offered.
    expect(rosters.allowedRoleIds).toEqual([ROLE_ID]);
  });

  test("skips role lookup for personal meetings", async () => {
    const listGuildRolesCached = rolesOk();
    const { buildMentionRosters } = await loadModule(listGuildRolesCached);

    const rosters = await buildMentionRosters(
      buildMeeting({ ownershipScope: "personal" }),
    );

    expect(listGuildRolesCached).not.toHaveBeenCalled();
    expect(rosters.roles).toMatch(/No roles are available/);
    expect(rosters.allowedRoleIds).toEqual([]);
  });

  test("degrades to no roles when Discord lookup fails rather than throwing", async () => {
    const listGuildRolesCached = jest
      .fn<(guildId: string) => Promise<unknown[]>>()
      .mockRejectedValue(new Error("rate limited"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { buildMentionRosters } = await loadModule(listGuildRolesCached);

    const rosters = await buildMentionRosters(buildMeeting());

    // A correction that cannot add a role mention still has to succeed.
    expect(rosters.roles).toMatch(/No roles are available/);
    expect(rosters.allowedRoleIds).toEqual([]);
    expect(rosters.allowedUserIds).toEqual([USER_ID]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("reports a placeholder when a meeting has no participants", async () => {
    const { buildMentionRosters } = await loadModule(rolesOk());

    const rosters = await buildMentionRosters(
      buildMeeting({ participants: [] }),
    );

    expect(rosters.participantRoster).toMatch(/No participant roster/);
    expect(rosters.allowedUserIds).toEqual([]);
  });
});
