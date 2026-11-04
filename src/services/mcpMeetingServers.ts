import type { McpTokenRestriction } from "../types/mcpOAuth";
import { buildCacheKey, cache, withCache } from "./cacheService";
import { config } from "./configService";
import {
  getGuildMemberCached,
  listBotGuildsCached,
} from "./discordCacheService";
import { isDiscordApiError } from "./discordService";
import { McpMeetingAccessError } from "./mcpMeetingErrors";
const MCP_SERVER_MEMBERSHIP_BATCH_SIZE = 5;

const resolveMcpServerMembership = async (
  guild: { id: string; name: string; icon?: string | null },
  userId: string,
) => {
  try {
    await getGuildMemberCached(guild.id, userId);
    return { guild, allowed: true };
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      throw new McpMeetingAccessError(
        "Discord rate limited. Please retry.",
        "rate_limited",
      );
    }
    if (isDiscordApiError(error) && [403, 404].includes(error.status))
      return { guild, allowed: false };
    throw error;
  }
};

async function listMcpServersForUserUncached(userId: string) {
  const guilds = await listBotGuildsCached();
  const memberships: Array<
    Awaited<ReturnType<typeof resolveMcpServerMembership>>
  > = [];
  for (
    let index = 0;
    index < guilds.length;
    index += MCP_SERVER_MEMBERSHIP_BATCH_SIZE
  ) {
    memberships.push(
      ...(await Promise.all(
        guilds
          .slice(index, index + MCP_SERVER_MEMBERSHIP_BATCH_SIZE)
          .map((guild) => resolveMcpServerMembership(guild, userId)),
      )),
    );
  }
  return memberships
    .filter((entry) => entry.allowed)
    .map(({ guild }) => ({ id: guild.id, name: guild.name, icon: guild.icon }));
}

const cachedMcpServersForUser = cache.define(
  "mcpServersForUser",
  {
    ttl: config.cache.discord.membersTtlSeconds,
    serialize: ({ userId }: { userId: string }) =>
      buildCacheKey(`mcp:serversForUser:${userId}`),
  },
  async ({ userId }: { userId: string }) =>
    listMcpServersForUserUncached(userId),
).mcpServersForUser;

const shouldFallbackMcpServerCache = (error: unknown) =>
  !(error instanceof McpMeetingAccessError);

export async function listMcpServersForUser(userId: string) {
  return withCache(
    "listMcpServersForUser",
    () => cachedMcpServersForUser({ userId }),
    () => listMcpServersForUserUncached(userId),
    shouldFallbackMcpServerCache,
  );
}

/**
 * Server list for one MCP caller. A restricted token resolves only its own
 * guild: validation already proved the bot is a member there, so the
 * cross-guild membership scan would add a request per guild Chronote is in and
 * let an unrelated rate limit fail a call whose answer is already known.
 */
export async function listMcpServersForToken(input: {
  userId: string;
  restriction?: McpTokenRestriction;
}) {
  const { restriction } = input;
  if (!restriction) return listMcpServersForUser(input.userId);
  const guilds = await listBotGuildsCached();
  return guilds
    .filter((guild) => guild.id === restriction.guildId)
    .map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon }));
}
