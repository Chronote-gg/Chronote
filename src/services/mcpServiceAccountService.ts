import crypto from "node:crypto";
import { getMcpOAuthRepository } from "../repositories/mcpOAuthRepository";
import {
  isMcpServiceAccountScope,
  MCP_SERVICE_ACCOUNT_TOKEN_PREFIX,
  type McpServiceAccountScope,
  type McpServiceAccountSummary,
  type McpServiceAccountToken,
} from "../types/mcpServiceAccount";
import type { McpAccessTokenInfo } from "../types/mcpOAuth";
import {
  formatMcpScope,
  getMcpResourceUrl,
  hashMcpToken,
  parseMcpScopes,
} from "./mcpOAuthService";
import {
  getGuildMemberCached,
  listGuildChannelsCached,
} from "./discordCacheService";
import { isDiscordApiError } from "./discordService";

const SERVICE_ACCOUNT_TOKEN_BYTES = 32;
const SECONDS_PER_DAY = 24 * 60 * 60;

export type McpServiceAccountErrorCode =
  | "bot_not_in_guild"
  | "not_a_bot"
  | "unknown_channel"
  | "rate_limited"
  | "not_found";

export class McpServiceAccountError extends Error {
  constructor(
    message: string,
    readonly code: McpServiceAccountErrorCode,
  ) {
    super(message);
  }
}

const epochSeconds = () => Math.floor(Date.now() / 1000);

const toSummary = (
  token: McpServiceAccountToken,
): McpServiceAccountSummary => ({
  tokenId: token.tokenId,
  guildId: token.guildId,
  botUserId: token.botUserId,
  name: token.name,
  scopes: parseMcpScopes(token.scope).filter(isMcpServiceAccountScope),
  channelIds: token.channelIds,
  createdAt: token.createdAt,
  createdByUserId: token.createdByUserId,
  expiresAt: token.expiresAt,
});

const fetchBotMember = async (guildId: string, botUserId: string) => {
  try {
    return await getGuildMemberCached(guildId, botUserId);
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpServiceAccountError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    throw new McpServiceAccountError(
      "That application is not a member of this server.",
      "bot_not_in_guild",
    );
  }
};

/**
 * A service account may only act as a bot. Binding one to a human's id would
 * let a server manager read that person's personal meetings and their access in
 * other servers, neither of which manage-guild permission covers.
 */
const assertBotIdentity = async (guildId: string, botUserId: string) => {
  const member = await fetchBotMember(guildId, botUserId);
  if (!member.user?.bot) {
    throw new McpServiceAccountError(
      "Service accounts can only act as a Discord application (bot) user.",
      "not_a_bot",
    );
  }
  // A bot holding Administrator is deliberately allowed. Administrator does
  // bypass every channel overwrite, so such a token reaches every meeting in
  // the guild, but minting already requires Administrator and an administrator
  // can read all of those meetings in the portal anyway. Refusing it prevented
  // no escalation and only forced people to restructure Discord for Chronote's
  // benefit. Use the channel allowlist when a bound token is wanted.
};

const assertChannelsInGuild = async (
  guildId: string,
  channelIds: string[] | undefined,
) => {
  if (!channelIds?.length) return;
  let channels;
  try {
    channels = await listGuildChannelsCached(guildId);
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpServiceAccountError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    throw error;
  }
  const known = new Set(channels.map((channel) => channel.id));
  const unknown = channelIds.find((channelId) => !known.has(channelId));
  if (unknown) {
    throw new McpServiceAccountError(
      "One or more channels do not belong to this server.",
      "unknown_channel",
    );
  }
};

const normalizeChannelIds = (channelIds?: string[]) => {
  if (!channelIds?.length) return undefined;
  return Array.from(new Set(channelIds));
};

export async function createMcpServiceAccountToken(params: {
  guildId: string;
  botUserId: string;
  name: string;
  scopes: McpServiceAccountScope[];
  channelIds?: string[];
  expiresInDays?: number;
  createdByUserId: string;
}): Promise<{ token: string; serviceAccount: McpServiceAccountSummary }> {
  const channelIds = normalizeChannelIds(params.channelIds);
  await assertBotIdentity(params.guildId, params.botUserId);
  await assertChannelsInGuild(params.guildId, channelIds);

  const token = `${MCP_SERVICE_ACCOUNT_TOKEN_PREFIX}${crypto
    .randomBytes(SERVICE_ACCOUNT_TOKEN_BYTES)
    .toString("base64url")}`;
  const record: McpServiceAccountToken = {
    tokenId: crypto.randomUUID(),
    tokenHash: hashMcpToken(token),
    guildId: params.guildId,
    botUserId: params.botUserId,
    name: params.name,
    scope: formatMcpScope(params.scopes),
    channelIds,
    createdAt: new Date().toISOString(),
    createdByUserId: params.createdByUserId,
    expiresAt: params.expiresInDays
      ? epochSeconds() + params.expiresInDays * SECONDS_PER_DAY
      : undefined,
  };
  await getMcpOAuthRepository().writeServiceAccountToken(record);
  return { token, serviceAccount: toSummary(record) };
}

export async function listMcpServiceAccountTokens(
  guildId: string,
): Promise<McpServiceAccountSummary[]> {
  const tokens =
    await getMcpOAuthRepository().listServiceAccountTokens(guildId);
  return tokens
    .map(toSummary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeMcpServiceAccountToken(params: {
  guildId: string;
  tokenId: string;
}): Promise<void> {
  const deleted = await getMcpOAuthRepository().deleteServiceAccountToken(
    params.guildId,
    params.tokenId,
  );
  if (!deleted) {
    throw new McpServiceAccountError("Service account not found.", "not_found");
  }
}

export const isMcpServiceAccountToken = (token: string) =>
  token.startsWith(MCP_SERVICE_ACCOUNT_TOKEN_PREFIX);

export async function validateMcpServiceAccountToken(
  token: string,
): Promise<McpAccessTokenInfo | undefined> {
  const record = await getMcpOAuthRepository().getServiceAccountTokenByHash(
    hashMcpToken(token),
  );
  if (!record) return undefined;
  // DynamoDB TTL deletion is eventual, so an expired record can still be read.
  if (record.expiresAt && record.expiresAt <= epochSeconds()) return undefined;
  try {
    return {
      clientId: `service-account:${record.tokenId}`,
      userId: record.botUserId,
      // Filtered rather than trusted, so a record written before the read-only
      // rule, or by a future path that forgets it, cannot carry a write scope.
      scopes: parseMcpScopes(record.scope).filter(isMcpServiceAccountScope),
      resource: getMcpResourceUrl(),
      expiresAt: record.expiresAt ?? Number.MAX_SAFE_INTEGER,
      restriction: {
        guildId: record.guildId,
        channelIds: record.channelIds,
      },
    };
  } catch {
    return undefined;
  }
}
