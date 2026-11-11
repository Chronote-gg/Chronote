import {
  getGuild,
  getGuildMember,
  isDiscordApiError,
  listGuildRoles,
} from "./discordService";
import { computeGuildBasePermissions } from "./discordPermissionsCompute";

export type GuildHistoryAuthorityDecision =
  | { allowed: true; via: "guild_owner" | "guild_administrator" }
  | { allowed: false }
  | { allowed: null };

export async function resolveGuildHistoryAuthority(options: {
  guildId: string;
  userId: string;
}): Promise<GuildHistoryAuthorityDecision> {
  const { guildId, userId } = options;
  try {
    const [guild, member] = await Promise.all([
      getGuild(guildId),
      getGuildMember(guildId, userId),
    ]);
    if (guild.id !== guildId || !guild.owner_id || member.user?.id !== userId) {
      return { allowed: false };
    }
    if (guild.owner_id === userId) return { allowed: true, via: "guild_owner" };
    if (!Array.isArray(member.roles)) return { allowed: false };
    const roles = await listGuildRoles(guildId);
    const requiredIds = [guildId, ...member.roles];
    if (
      !requiredIds.every((id) =>
        roles.some((role) => role.id === id && /^\d+$/.test(role.permissions)),
      )
    ) {
      return { allowed: false };
    }
    const permissions = computeGuildBasePermissions(
      guildId,
      roles,
      member.roles,
    );
    return (permissions & (1n << 3n)) !== 0n
      ? { allowed: true, via: "guild_administrator" }
      : { allowed: false };
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429)
      return { allowed: null };
    console.warn("Guild history authority unavailable", { guildId, error });
    return { allowed: false };
  }
}
