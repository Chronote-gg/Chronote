import type { DiscordPermissionOverwrite } from "../repositories/types";

const PERMISSION_ADMIN = 1n << 3n;
const ALL_PERMISSIONS = (1n << 64n) - 1n;
const OVERWRITE_TYPE_ROLE = 0;
const OVERWRITE_TYPE_MEMBER = 1;

export type PermissionRole = { id: string; permissions?: string | null };

export type ChannelPermissionsInput = {
  guildId: string;
  memberId: string;
  roles: PermissionRole[];
  memberRoleIds: string[];
  overwrites: DiscordPermissionOverwrite[];
};

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
    if (overwrite.type !== OVERWRITE_TYPE_ROLE) continue;
    if (!roleIds.includes(overwrite.id)) continue;
    const bits = getOverwriteBits(overwrite);
    allow |= bits.allow;
    deny |= bits.deny;
  }
  return (base & ~deny) | allow;
};

/**
 * Guild-wide permissions for a member: the @everyone role (whose id equals the
 * guild id) unioned with every role the member holds, before channel overwrites.
 */
const computeGuildBasePermissions = (
  guildId: string,
  roles: PermissionRole[],
  memberRoleIds: string[],
) => {
  const rolePermissions = new Map(
    roles.map((role) => [role.id, parsePermissions(role.permissions)]),
  );
  let permissions = rolePermissions.get(guildId) ?? 0n;
  for (const roleId of memberRoleIds) {
    permissions |= rolePermissions.get(roleId) ?? 0n;
  }
  return permissions;
};

/**
 * A member's effective permissions in one channel, following Discord's order:
 * base role bits, then the @everyone overwrite, then the member's role
 * overwrites unioned (all denies, then all allows), then the member overwrite.
 * Administrator short-circuits to every bit.
 */
export const computeChannelPermissions = ({
  guildId,
  memberId,
  roles,
  memberRoleIds,
  overwrites,
}: ChannelPermissionsInput): bigint => {
  const base = computeGuildBasePermissions(guildId, roles, memberRoleIds);
  if ((base & PERMISSION_ADMIN) !== 0n) return ALL_PERMISSIONS;

  let permissions = applyOverwrite(
    base,
    overwrites.find(
      (overwrite) =>
        overwrite.type === OVERWRITE_TYPE_ROLE && overwrite.id === guildId,
    ),
  );
  permissions = applyRoleOverwrites(permissions, overwrites, memberRoleIds);
  return applyOverwrite(
    permissions,
    overwrites.find(
      (overwrite) =>
        overwrite.type === OVERWRITE_TYPE_MEMBER && overwrite.id === memberId,
    ),
  );
};
