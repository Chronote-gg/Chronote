import { isDiscordApiError } from "./discordService";
import {
  getGuildMemberCached,
  listGuildChannelsCached,
  listGuildRolesCached,
} from "./discordCacheService";
import type {
  DiscordChannel,
  DiscordPermissionOverwrite,
} from "../repositories/types";

const PERMISSION_ADMIN = 1n << 3n;
const PERMISSION_MANAGE_CHANNELS = 1n << 4n;
const PERMISSION_VIEW_CHANNEL = 1n << 10n;
const PERMISSION_CONNECT = 1n << 20n;

const parsePermissions = (value?: string | null): bigint => {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch (error) {
    console.warn("Failed to parse permissions value", error);
    return 0n;
  }
};

const getOverwriteBits = (overwrite: DiscordPermissionOverwrite) => ({
  allow: parsePermissions(overwrite.allow),
  deny: parsePermissions(overwrite.deny),
});

const applyOverwrite = (
  base: bigint,
  overwrite?: DiscordPermissionOverwrite,
) => {
  if (!overwrite) return base;
  const { allow, deny } = getOverwriteBits(overwrite);
  return (base & ~deny) | allow;
};

const applyRoleOverwrites = (
  base: bigint,
  overwrites: DiscordPermissionOverwrite[],
  roleIds: string[],
) => {
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0) continue;
    if (!roleIds.includes(overwrite.id)) continue;
    const bits = getOverwriteBits(overwrite);
    allow |= bits.allow;
    deny |= bits.deny;
  }
  return (base & ~deny) | allow;
};

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

    const rolePermissions = new Map(
      roles.map((role) => [role.id, parsePermissions(role.permissions)]),
    );
    let permissions = rolePermissions.get(guildId) ?? 0n;
    const memberRoles = member.roles ?? [];
    for (const roleId of memberRoles) {
      permissions |= rolePermissions.get(roleId) ?? 0n;
    }

    if ((permissions & PERMISSION_ADMIN) !== 0n) {
      return true;
    }

    const overwrites = channel.permission_overwrites ?? [];
    permissions = applyOverwrite(
      permissions,
      overwrites.find(
        (overwrite) => overwrite.type === 0 && overwrite.id === guildId,
      ),
    );
    permissions = applyRoleOverwrites(permissions, overwrites, memberRoles);
    permissions = applyOverwrite(
      permissions,
      overwrites.find(
        (overwrite) => overwrite.type === 1 && overwrite.id === userId,
      ),
    );

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
