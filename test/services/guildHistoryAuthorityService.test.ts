import { resolveGuildHistoryAuthority } from "../../src/services/guildHistoryAuthorityService";
import {
  DiscordApiError,
  getGuild,
  getGuildMember,
  listGuildRoles,
} from "../../src/services/discordService";

jest.mock("../../src/services/discordService", () => ({
  ...jest.requireActual("../../src/services/discordService"),
  getGuild: jest.fn(),
  getGuildMember: jest.fn(),
  listGuildRoles: jest.fn(),
}));

const check = () =>
  resolveGuildHistoryAuthority({ guildId: "guild-1", userId: "user-1" });
beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(getGuild)
    .mockResolvedValue({ id: "guild-1", name: "Test", owner_id: "other" });
  jest
    .mocked(getGuildMember)
    .mockResolvedValue({ user: { id: "user-1" }, roles: ["role-1"] });
  jest.mocked(listGuildRoles).mockResolvedValue([
    { id: "guild-1", permissions: "0" },
    { id: "role-1", permissions: "8" },
  ]);
});

test("allows the current owner without reading roles", async () => {
  jest
    .mocked(getGuild)
    .mockResolvedValue({ id: "guild-1", name: "Test", owner_id: "user-1" });
  await expect(check()).resolves.toEqual({ allowed: true, via: "guild_owner" });
  expect(listGuildRoles).not.toHaveBeenCalled();
});
test("allows an Administrator role", async () => {
  await expect(check()).resolves.toEqual({
    allowed: true,
    via: "guild_administrator",
  });
});
test("includes the default role", async () => {
  jest
    .mocked(getGuildMember)
    .mockResolvedValue({ user: { id: "user-1" }, roles: [] });
  jest
    .mocked(listGuildRoles)
    .mockResolvedValue([{ id: "guild-1", permissions: "8" }]);
  await expect(check()).resolves.toEqual({
    allowed: true,
    via: "guild_administrator",
  });
});
test.each(["16", "32", "48", "0", "-1", "invalid", ""])(
  "does not grant for permissions %s",
  async (permissions) => {
    jest.mocked(listGuildRoles).mockResolvedValue([
      { id: "guild-1", permissions: "0" },
      { id: "role-1", permissions },
    ]);
    await expect(check()).resolves.toEqual({ allowed: false });
  },
);
test("requires every assigned role and the default role to be known", async () => {
  jest.mocked(getGuildMember).mockResolvedValue({
    user: { id: "user-1" },
    roles: ["role-1", "missing"],
  });
  await expect(check()).resolves.toEqual({ allowed: false });
  jest
    .mocked(listGuildRoles)
    .mockResolvedValue([{ id: "role-1", permissions: "8" }]);
  await expect(check()).resolves.toEqual({ allowed: false });
});
test("requires verified guild and member identities", async () => {
  jest
    .mocked(getGuild)
    .mockResolvedValue({ id: "wrong", name: "Test", owner_id: "user-1" });
  await expect(check()).resolves.toEqual({ allowed: false });
  jest.mocked(getGuild).mockResolvedValue({ id: "guild-1", name: "Test" });
  await expect(check()).resolves.toEqual({ allowed: false });
  jest
    .mocked(getGuild)
    .mockResolvedValue({ id: "guild-1", name: "Test", owner_id: "user-1" });
  jest
    .mocked(getGuildMember)
    .mockResolvedValue({ user: { id: "wrong" }, roles: [] });
  await expect(check()).resolves.toEqual({ allowed: false });
});
test.each([403, 404, 500, 429])(
  "fails closed for Discord %s",
  async (status) => {
    jest
      .mocked(getGuildMember)
      .mockRejectedValue(new DiscordApiError(status, "Unavailable"));
    await expect(check()).resolves.toEqual({
      allowed: status === 429 ? null : false,
    });
  },
);
test("fresh checks see revoked Administrator and transferred ownership", async () => {
  await expect(check()).resolves.toMatchObject({ allowed: true });
  jest.mocked(listGuildRoles).mockResolvedValue([
    { id: "guild-1", permissions: "0" },
    { id: "role-1", permissions: "0" },
  ]);
  await expect(check()).resolves.toEqual({ allowed: false });
  expect(getGuildMember).toHaveBeenCalledTimes(2);
});
