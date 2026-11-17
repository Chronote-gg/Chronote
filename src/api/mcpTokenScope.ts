import type { McpTokenRestriction } from "../types/mcpOAuth";

const TOKEN_SERVER_SCOPE_ERROR =
  "This token is scoped to a different Discord server.";
/** A service account token asked for something outside its own bounds. */
export class McpTokenScopeError extends Error {}

export const assertTokenGuildId = (
  restriction: McpTokenRestriction | undefined,
  serverId?: string,
) => {
  if (restriction && serverId && serverId !== restriction.guildId) {
    throw new McpTokenScopeError(TOKEN_SERVER_SCOPE_ERROR);
  }
};

export const resolveTokenServerIds = (
  restriction: McpTokenRestriction | undefined,
  serverIds?: string[],
) => {
  if (!restriction) return serverIds;
  if (serverIds?.some((serverId) => serverId !== restriction.guildId)) {
    throw new McpTokenScopeError(TOKEN_SERVER_SCOPE_ERROR);
  }
  return [restriction.guildId];
};
