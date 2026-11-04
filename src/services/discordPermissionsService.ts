import { isDiscordApiError } from "./discordService";
import {
  getGuildMemberCached,
  listGuildChannelsCached,
  listGuildRolesCached,
} from "./discordCacheService";
import { computeChannelPermissions } from "./discordPermissionsCompute";
import type { DiscordChannel } from "../repositories/types";

export { computeChannelPermissions };

const PERMISSION_MANAGE_CHANNELS = 1n << 4n;
const PERMISSION_VIEW_CHANNEL = 1n << 10n;
const PERMISSION_READ_MESSAGE_HISTORY = 1n << 16n;
const PERMISSION_CONNECT = 1n << 20n;

const resolveChannel = (
  channels: DiscordChannel[],
  channelId: string,
): DiscordChannel | undefined =>
  channels.find((channel) => channel.id === channelId);

const ensureUserHasChannelPermissions = async (options: {
  guildId: string;
  channelId: string;
  userId: string;
  required: bigint;
  logLabel: string;
}): Promise<boolean | null> => {
  const { guildId, channelId, userId, required, logLabel } = options;
  try {
    const [channels, roles, member] = await Promise.all([
      listGuildChannelsCached(guildId),
      listGuildRolesCached(guildId),
      getGuildMemberCached(guildId, userId),
    ]);

    const channel = resolveChannel(channels, channelId);
    if (!channel) return false;

    const permissions = computeChannelPermissions({
      guildId,
      memberId: userId,
      roles,
      memberRoleIds: member.roles ?? [],
      overwrites: channel.permission_overwrites ?? [],
    });

    return (permissions & required) === required;
  } catch (error) {
    if (isDiscordApiError(error) && error.status === 429) {
      console.warn(`${logLabel} rate limited`, {
        guildId,
        channelId,
      });
      return null;
    }
    console.error(`${logLabel} error`, error);
    return false;
  }
};

export async function ensureUserCanViewChannel(options: {
  guildId: string;
  channelId: string;
  userId: string;
}): Promise<boolean | null> {
  return ensureUserHasChannelPermissions({
    ...options,
    required: PERMISSION_VIEW_CHANNEL,
    logLabel: "ensureUserCanViewChannel",
  });
}

export async function ensureUserCanConnectChannel(options: {
  guildId: string;
  channelId: string;
  userId: string;
}): Promise<boolean | null> {
  return ensureUserHasChannelPermissions({
    ...options,
    required: PERMISSION_VIEW_CHANNEL | PERMISSION_CONNECT,
    logLabel: "ensureUserCanConnectChannel",
  });
}

export async function ensureUserCanManageChannel(options: {
  guildId: string;
  channelId: string;
  userId: string;
}): Promise<boolean | null> {
  return ensureUserHasChannelPermissions({
    ...options,
    required: PERMISSION_VIEW_CHANNEL | PERMISSION_MANAGE_CHANNELS,
    logLabel: "ensureUserCanManageChannel",
  });
}

export async function ensureUserCanReadChannelHistory(options: {
  guildId: string;
  channelId: string;
  userId: string;
}): Promise<boolean | null> {
  return ensureUserHasChannelPermissions({
    ...options,
    required: PERMISSION_VIEW_CHANNEL | PERMISSION_READ_MESSAGE_HISTORY,
    logLabel: "ensureUserCanReadChannelHistory",
  });
}
