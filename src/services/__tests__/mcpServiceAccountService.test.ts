import { jest } from "@jest/globals";
import {
  getGuildMemberCached,
  listGuildChannelsCached,
} from "../discordCacheService";
import {
  createMcpServiceAccountToken,
  isMcpServiceAccountToken,
  listMcpServiceAccountTokens,
  McpServiceAccountError,
  revokeMcpServiceAccountToken,
  validateMcpServiceAccountToken,
} from "../mcpServiceAccountService";
import {
  getMcpOAuthRepository,
  resetMcpOAuthMemoryRepository,
} from "../../repositories/mcpOAuthRepository";
import { hashMcpToken } from "../mcpOAuthService";
import { isDiscordApiError } from "../discordService";

jest.mock("../discordService", () => ({
  isDiscordApiError: jest.fn(() => false),
}));

jest.mock("../discordCacheService", () => ({
  getGuildMemberCached: jest.fn(),
  listGuildChannelsCached: jest.fn(),
}));

const getGuildMemberCachedMock = jest.mocked(getGuildMemberCached);
const listGuildChannelsCachedMock = jest.mocked(listGuildChannelsCached);

const GUILD_ID = "100000000000000001";
const BOT_USER_ID = "100000000000000002";
const HUMAN_USER_ID = "100000000000000003";
const CHANNEL_ID = "100000000000000004";
const OTHER_CHANNEL_ID = "100000000000000005";

const asBotMember = (bot: boolean) => ({
  user: { id: BOT_USER_ID, bot },
  roles: [],
});

const createToken = (
  overrides: Partial<Parameters<typeof createMcpServiceAccountToken>[0]> = {},
) =>
  createMcpServiceAccountToken({
    guildId: GUILD_ID,
    botUserId: BOT_USER_ID,
    name: "Ops agent",
    scopes: ["meetings:read"],
    createdByUserId: HUMAN_USER_ID,
    ...overrides,
  });

describe("mcpServiceAccountService", () => {
  beforeEach(() => {
    resetMcpOAuthMemoryRepository();
    jest.clearAllMocks();
    // clearAllMocks leaves implementations in place, so this is pinned rather
    // than inherited from whichever test ran last.
    jest.mocked(isDiscordApiError).mockReturnValue(false);
    getGuildMemberCachedMock.mockResolvedValue(asBotMember(true));
    listGuildChannelsCachedMock.mockResolvedValue([
      { id: CHANNEL_ID, name: "meetings", type: 2 },
      { id: OTHER_CHANNEL_ID, name: "board", type: 2 },
    ]);
  });

  it("mints a prefixed token that validates back to the bot identity", async () => {
    const { token, serviceAccount } = await createToken({
      channelIds: [CHANNEL_ID],
    });

    expect(isMcpServiceAccountToken(token)).toBe(true);
    expect(serviceAccount.botUserId).toBe(BOT_USER_ID);

    const auth = await validateMcpServiceAccountToken(token);
    expect(auth).toMatchObject({
      userId: BOT_USER_ID,
      scopes: ["meetings:read"],
      restriction: { guildId: GUILD_ID, channelIds: [CHANNEL_ID] },
    });
  });

  it("stores only a hash of the token", async () => {
    const { token } = await createToken();
    const stored =
      await getMcpOAuthRepository().listServiceAccountTokens(GUILD_ID);

    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(hashMcpToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("refuses to bind a service account to a human user", async () => {
    getGuildMemberCachedMock.mockResolvedValue(asBotMember(false));

    await expect(createToken()).rejects.toMatchObject({ code: "not_a_bot" });
  });

  it("refuses a bot that is not in the guild", async () => {
    getGuildMemberCachedMock.mockRejectedValue(new Error("404"));

    await expect(createToken()).rejects.toMatchObject({
      code: "bot_not_in_guild",
    });
  });

  it("refuses channels that do not belong to the guild", async () => {
    await expect(
      createToken({ channelIds: ["100000000000000099"] }),
    ).rejects.toMatchObject({ code: "unknown_channel" });
  });

  // Minting already requires the caller to be a guild administrator, who can
  // read every meeting in the portal, so binding to an administrator bot
  // delegates nothing they did not already hold.
  it("allows a bot holding Administrator", async () => {
    const { token } = await createToken();

    expect(await validateMcpServiceAccountToken(token)).toMatchObject({
      userId: BOT_USER_ID,
    });
  });

  it("stops honouring a token once its bot leaves the guild", async () => {
    const { token } = await createToken();
    expect(await validateMcpServiceAccountToken(token)).toBeDefined();

    getGuildMemberCachedMock.mockRejectedValue(new Error("404"));

    expect(await validateMcpServiceAccountToken(token)).toBeUndefined();
  });

  it("keeps a token alive when Discord rate limits the membership check", async () => {
    // A 429 is not evidence the bot left, so a Discord blip must not sign the
    // agent out mid-run.
    const { token } = await createToken();
    jest.mocked(isDiscordApiError).mockReturnValue(true);
    getGuildMemberCachedMock.mockRejectedValue({ status: 429 });

    expect(await validateMcpServiceAccountToken(token)).toBeDefined();
  });

  it("still bounds an Administrator bot by the channel allowlist", async () => {
    const { token } = await createToken({ channelIds: [CHANNEL_ID] });

    expect(await validateMcpServiceAccountToken(token)).toMatchObject({
      restriction: { guildId: GUILD_ID, channelIds: [CHANNEL_ID] },
    });
  });

  it("drops write scopes from a stored record", async () => {
    const { token } = await createToken();
    const repository = getMcpOAuthRepository();
    const record = await repository.getServiceAccountTokenByHash(
      hashMcpToken(token),
    );
    if (!record) throw new Error("Expected a stored service account token.");
    await repository.writeServiceAccountToken({
      ...record,
      scope: "meetings:read meetings:start meetings:stop",
    });

    const auth = await validateMcpServiceAccountToken(token);
    expect(auth?.scopes).toEqual(["meetings:read"]);
  });

  it("rejects an expired token without waiting for the TTL sweep", async () => {
    const { token, serviceAccount } = await createToken({ expiresInDays: 1 });
    const repository = getMcpOAuthRepository();
    const record = await repository.getServiceAccountTokenByHash(
      hashMcpToken(token),
    );
    if (!record) throw new Error("Expected a stored service account token.");
    await repository.writeServiceAccountToken({ ...record, expiresAt: 1 });

    expect(await validateMcpServiceAccountToken(token)).toBeUndefined();
    expect(serviceAccount.expiresAt).toBeGreaterThan(0);
  });

  it("stops validating once revoked", async () => {
    const { token, serviceAccount } = await createToken();

    await revokeMcpServiceAccountToken({
      guildId: GUILD_ID,
      tokenId: serviceAccount.tokenId,
    });

    expect(await validateMcpServiceAccountToken(token)).toBeUndefined();
    expect(await listMcpServiceAccountTokens(GUILD_ID)).toEqual([]);
  });

  it("does not revoke a token belonging to another guild", async () => {
    const { serviceAccount } = await createToken();

    await expect(
      revokeMcpServiceAccountToken({
        guildId: "100000000000000098",
        tokenId: serviceAccount.tokenId,
      }),
    ).rejects.toBeInstanceOf(McpServiceAccountError);
  });
});
