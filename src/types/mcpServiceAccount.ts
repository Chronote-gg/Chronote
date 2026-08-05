import type { McpScope } from "./mcpOAuth";

/**
 * Prefix on the raw secret so it is recognizable in logs, secret scanners, and
 * the bearer dispatcher without needing a database lookup first.
 */
export const MCP_SERVICE_ACCOUNT_TOKEN_PREFIX = "cnsa_";

export const MCP_SERVICE_ACCOUNT_NAME_MAX_LENGTH = 80;
export const MCP_SERVICE_ACCOUNT_MAX_CHANNEL_IDS = 50;
export const MCP_SERVICE_ACCOUNT_MAX_EXPIRY_DAYS = 365;

/**
 * A long-lived MCP credential that acts as a Discord bot user inside exactly
 * one guild. Meeting access is still resolved from that bot's Discord roles and
 * channel overwrites; `channelIds` only narrows further, it never widens.
 */
export type McpServiceAccountToken = {
  tokenId: string;
  tokenHash: string;
  guildId: string;
  botUserId: string;
  name: string;
  scope: string;
  channelIds?: string[];
  createdAt: string;
  createdByUserId: string;
  expiresAt?: number;
};

export type McpServiceAccountSummary = {
  tokenId: string;
  guildId: string;
  botUserId: string;
  name: string;
  scopes: McpScope[];
  channelIds?: string[];
  createdAt: string;
  createdByUserId: string;
  expiresAt?: number;
};
