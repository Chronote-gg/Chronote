import {
  DiscordApiError,
  getDiscordRepository,
  isDiscordApiError,
} from "../repositories/discordRepository";

export { DiscordApiError, isDiscordApiError };

export async function listUserGuilds(accessToken: string) {
  return getDiscordRepository().listUserGuilds(accessToken);
}

export async function listBotGuilds() {
  return getDiscordRepository().listBotGuilds();
}

export async function listGuildChannels(guildId: string) {
  return getDiscordRepository().listGuildChannels(guildId);
}

export async function listGuildRoles(guildId: string) {
  return getDiscordRepository().listGuildRoles(guildId);
}

export async function getGuildMember(guildId: string, userId: string) {
  return getDiscordRepository().getGuildMember(guildId, userId);
}

export async function getGuild(guildId: string) {
  return getDiscordRepository().getGuild(guildId);
}
