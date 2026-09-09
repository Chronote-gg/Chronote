import {
  getGuild,
  getGuildMember,
  listGuildRoles,
} from "../../src/services/discordService";
import { config } from "../../src/services/configService";
jest.mock("../../src/services/discordService", () => ({
  getGuildMember: jest.fn(),
  getGuild: jest.fn(),
  listGuildRoles: jest.fn(),
}));
const getGuildMemberMock = jest.mocked(getGuildMember);
const getGuildMock = jest.mocked(getGuild);
const listGuildRolesMock = jest.mocked(listGuildRoles);
import { beforeEach, describe, expect, test } from "@jest/globals";
import { resetMockStore } from "../../src/repositories/mockStore";
import {
  fetchGuildInstaller,
  fetchGuildInstallerForMembership,
  saveGuildInstallerForCurrentMembership,
  removeGuildInstaller,
  saveGuildInstallerIfAbsent,
} from "../../src/services/guildInstallerService";

describe("guildInstallerService", () => {
  beforeEach(() => resetMockStore());

  test("preserves the first installer and attribution record", async () => {
    const guildId = "555555555555555555";
    const first = {
      guildId,
      installerId: "111111111111111111",
      installedAt: "2026-08-28T12:00:00.000Z",
      acquisition: {
        source: "chatgpt.com",
        medium: "referral",
        landingPath: "/",
        ctaLocation: "hero",
        capturedAt: "2026-08-28T11:59:00.000Z",
      },
    };
    const repeat = {
      guildId,
      installerId: "222222222222222222",
      installedAt: "2026-08-29T12:00:00.000Z",
      acquisition: {
        source: "direct",
        medium: "web",
        landingPath: "/join",
        ctaLocation: "join",
        capturedAt: "2026-08-29T11:59:00.000Z",
      },
    };

    await expect(saveGuildInstallerIfAbsent(first)).resolves.toBe(true);
    await expect(saveGuildInstallerIfAbsent(repeat)).resolves.toBe(false);
    await expect(fetchGuildInstaller(guildId)).resolves.toEqual(first);
  });
});

describe("installer removal lifecycle", () => {
  beforeEach(() => resetMockStore());

  const first = {
    guildId: "555555555555555555",
    installerId: "111111111111111111",
    installedAt: "2026-08-28T12:00:00.000Z",
  };
  const removedAt = "2026-08-29T12:00:00.000Z";
  const reinstall = {
    ...first,
    installerId: "222222222222222222",
    installedAt: "2026-08-30T12:00:00.000Z",
    acquisition: {
      source: "direct",
      medium: "web",
      capturedAt: "2026-08-30T12:00:00.000Z",
    },
  };

  test("allows a new installer and attribution after removal", async () => {
    await saveGuildInstallerIfAbsent(first);
    await removeGuildInstaller(first.guildId, removedAt);
    await expect(fetchGuildInstaller(first.guildId)).resolves.toBeUndefined();
    await expect(saveGuildInstallerIfAbsent(reinstall)).resolves.toBe(true);
    await expect(fetchGuildInstaller(first.guildId)).resolves.toEqual(
      reinstall,
    );
  });

  test("delayed removal cannot erase a newer installation", async () => {
    await saveGuildInstallerIfAbsent(reinstall);
    await removeGuildInstaller(first.guildId, removedAt);
    await expect(fetchGuildInstaller(first.guildId)).resolves.toEqual(
      reinstall,
    );
  });

  test("removing a missing installer is harmless", async () => {
    await expect(
      removeGuildInstaller(first.guildId, removedAt),
    ).resolves.toBeUndefined();
  });
});

describe("current membership installer", () => {
  const guildId = "555555555555555555";
  const joinedAt = "2026-09-05T10:00:00.000Z";
  const old = {
    guildId,
    installerId: "old",
    installedAt: "2026-09-01T10:00:00.000Z",
  };
  const current = {
    guildId,
    installerId: "current",
    installedAt: "2026-09-05T10:00:01.000Z",
  };

  beforeEach(() => {
    resetMockStore();
    getGuildMemberMock.mockReset();
    getGuildMock.mockReset();
    listGuildRolesMock.mockReset();
    getGuildMock.mockResolvedValue({
      id: guildId,
      name: "Guild",
      owner_id: "owner",
    });
    listGuildRolesMock.mockResolvedValue([{ id: guildId, permissions: "32" }]);
    getGuildMemberMock.mockResolvedValue({ roles: [], joined_at: joinedAt });
  });

  test("replaces stale attribution after an offline removal and reinstall", async () => {
    await saveGuildInstallerIfAbsent(old);
    await expect(
      fetchGuildInstallerForMembership(guildId, Date.parse(joinedAt)),
    ).resolves.toBeUndefined();
    await expect(saveGuildInstallerForCurrentMembership(current)).resolves.toBe(
      true,
    );
    expect(getGuildMemberMock).toHaveBeenCalledWith(
      guildId,
      config.discord.clientId,
    );
    await expect(
      fetchGuildInstallerForMembership(guildId, Date.parse(joinedAt)),
    ).resolves.toEqual(current);
  });

  test("same membership reauthorization preserves the installer", async () => {
    await saveGuildInstallerForCurrentMembership(current);
    await expect(
      saveGuildInstallerForCurrentMembership({
        ...current,
        installerId: "other",
      }),
    ).resolves.toBe(false);
    await expect(fetchGuildInstaller(guildId)).resolves.toEqual(current);
  });

  test("a stale membership response cannot replace a newer membership record", async () => {
    await saveGuildInstallerIfAbsent(current);
    getGuildMemberMock.mockResolvedValue({
      roles: [],
      joined_at: old.installedAt,
    });
    await expect(saveGuildInstallerForCurrentMembership(old)).resolves.toBe(
      false,
    );
    await expect(fetchGuildInstaller(guildId)).resolves.toEqual(current);
  });

  test("normalizes Discord microseconds and protects against local clock skew", async () => {
    getGuildMemberMock.mockResolvedValue({
      roles: [],
      joined_at: "2026-09-05T10:00:00.123456+00:00",
    });
    await expect(saveGuildInstallerForCurrentMembership(old)).resolves.toBe(
      true,
    );
    await expect(fetchGuildInstaller(guildId)).resolves.toEqual({
      ...old,
      installedAt: "2026-09-05T10:00:00.123Z",
    });
    await expect(saveGuildInstallerForCurrentMembership(current)).resolves.toBe(
      false,
    );
  });

  test.each([undefined, "invalid"])(
    "refuses unknown membership date %s",
    async (joined_at) => {
      getGuildMemberMock.mockResolvedValue({ roles: [], joined_at });
      await expect(
        saveGuildInstallerForCurrentMembership(current),
      ).rejects.toThrow("membership join timestamp");
      await expect(fetchGuildInstaller(guildId)).resolves.toBeUndefined();
    },
  );

  test.each([null, NaN])(
    "does not grant installer access with unknown joinedTimestamp %s",
    async (joinedTimestamp) => {
      await saveGuildInstallerIfAbsent(current);
      await expect(
        fetchGuildInstallerForMembership(guildId, joinedTimestamp),
      ).resolves.toBeUndefined();
    },
  );
});

describe("callback installer authorization", () => {
  const installer = {
    guildId: "555555555555555555",
    installerId: "actor",
    installedAt: "2026-09-05T10:00:01.000Z",
  };
  beforeEach(() => {
    resetMockStore();
    getGuildMock.mockReset();
    getGuildMemberMock.mockReset();
    listGuildRolesMock.mockReset();
    getGuildMock.mockResolvedValue({
      id: installer.guildId,
      name: "Guild",
      owner_id: "owner",
    });
    getGuildMemberMock.mockImplementation(async (_guildId, userId) =>
      userId === config.discord.clientId
        ? { roles: [], joined_at: "2026-09-05T10:00:00.000Z" }
        : { roles: ["actor-role"] },
    );
    listGuildRolesMock.mockResolvedValue([
      { id: "actor-role", permissions: "0" },
    ]);
  });

  test("an unsigned guild substitution cannot register an unauthorized installer even when the bot is a member", async () => {
    await expect(
      saveGuildInstallerForCurrentMembership(installer),
    ).rejects.toThrow("Manage Guild");
    await expect(
      fetchGuildInstaller(installer.guildId),
    ).resolves.toBeUndefined();
  });

  test.each(["32", "8"])(
    "allows an actor whose role grants permission %s",
    async (permissions) => {
      listGuildRolesMock.mockResolvedValue([{ id: "actor-role", permissions }]);
      await expect(
        saveGuildInstallerForCurrentMembership(installer),
      ).resolves.toBe(true);
      expect(getGuildMemberMock).toHaveBeenCalledWith(
        installer.guildId,
        installer.installerId,
      );
    },
  );

  test("does not inherit another member's management role", async () => {
    listGuildRolesMock.mockResolvedValue([
      { id: "someone-elses-role", permissions: "32" },
    ]);
    await expect(
      saveGuildInstallerForCurrentMembership(installer),
    ).rejects.toThrow("Manage Guild");
    await expect(
      fetchGuildInstaller(installer.guildId),
    ).resolves.toBeUndefined();
  });

  test("includes the everyone role in guild permissions", async () => {
    listGuildRolesMock.mockResolvedValue([
      { id: installer.guildId, permissions: "32" },
    ]);
    await expect(
      saveGuildInstallerForCurrentMembership(installer),
    ).resolves.toBe(true);
  });
  test("allows the owner without a management role", async () => {
    getGuildMock.mockResolvedValue({
      id: installer.guildId,
      name: "Guild",
      owner_id: installer.installerId,
    });
    await expect(
      saveGuildInstallerForCurrentMembership(installer),
    ).resolves.toBe(true);
  });

  test.each(["guild", "member", "roles"])(
    "fails closed when %s authorization data is unavailable",
    async (resource) => {
      if (resource === "guild")
        getGuildMock.mockRejectedValue(new Error("Discord unavailable"));
      if (resource === "member")
        getGuildMemberMock.mockRejectedValue(new Error("Discord unavailable"));
      if (resource === "roles")
        listGuildRolesMock.mockRejectedValue(new Error("Discord unavailable"));
      await expect(
        saveGuildInstallerForCurrentMembership(installer),
      ).rejects.toThrow();
      await expect(
        fetchGuildInstaller(installer.guildId),
      ).resolves.toBeUndefined();
    },
  );
});
