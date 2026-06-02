import type { Guild, GuildMember } from "discord.js";

export async function fetchGuildMember(
  guild: Guild,
  userId: string,
): Promise<GuildMember | null> {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;

  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}
