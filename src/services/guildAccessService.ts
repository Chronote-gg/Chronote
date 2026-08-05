import { isDiscordApiError } from "./discordService";
import {
  getGuildMemberCached,
  listBotGuildsCached,
  listGuildRolesCached,
  listUserGuildsCached,
} from "./discordCacheService";
import type { Session, SessionData } from "express-session";
import type {
  DiscordGuild,
  DiscordGuildMember,
  DiscordRole,
} from "../repositories/types";

const MANAGE_GUILD = 1n << 5n;
const ADMIN = 1n << 3n;
const USER_GUILD_CACHE_TTL_MS = 60_000;
const MANAGE_GUILD_CACHE_TTL_MS = 60_000;

type ManageGuildCacheEntry = {
  allowed: boolean;
  fetchedAt: number;
};

export type GuildSessionCache = (Session & Partial<SessionData>) & {
  guildIds?: string[];
  guildIdsFetchedAt?: number;
  userGuilds?: DiscordGuild[];
  userGuildsFetchedAt?: number;
  manageGuildCache?: Record<string, ManageGuildCacheEntry>;
};

type EnsureManageGuildOptions = {
  userId?: string;
  session?: GuildSessionCache;
};

type EnsureUserGuildOptions = {
  session?: GuildSessionCache;
  userId?: string;
};

const isCacheFresh = (fetchedAt: number | undefined, ttlMs: number) =>
  fetchedAt != null ? Date.now() - fetchedAt < ttlMs : false;

const parsePermissions = (value?: string | null): bigint => {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch (error) {
    console.warn("Failed to parse permissions value", error);
    return 0n;
  }
};

const hasManageGuildPermissions = (permissions: bigint) =>
  (permissions & MANAGE_GUILD) !== 0n || (permissions & ADMIN) !== 0n;

const resolveManageFromUserGuilds = (
  guilds: DiscordGuild[],
  guildId: string,
) => {
  const target = guilds.find((g) => g.id === guildId);
  if (!target) return false;
  if (target.owner) return true;
  const perms = parsePermissions(target.permissions);
  return hasManageGuildPermissions(perms);
};

const getCachedGuildIds = (session?: GuildSessionCache): string[] | null => {
  if (!session) return null;
  if (
    isCacheFresh(session.guildIdsFetchedAt, USER_GUILD_CACHE_TTL_MS) &&
    session.guildIds
  ) {
    return session.guildIds;
  }
  if (isCacheFresh(session.userGuildsFetchedAt, USER_GUILD_CACHE_TTL_MS)) {
    if (!session.userGuilds) return null;
    const ids = session.userGuilds.map((guild) => guild.id);
    session.guildIds = ids;
    session.guildIdsFetchedAt = session.userGuildsFetchedAt;
    return ids;
  }
  return null;
};

const getCachedUserGuilds = (
  session?: GuildSessionCache,
): DiscordGuild[] | null => {
  if (!session) return null;
  if (!isCacheFresh(session.userGuildsFetchedAt, USER_GUILD_CACHE_TTL_MS)) {
    return null;
  }
  if (!session.userGuilds) return null;
  return session.userGuilds;
};

const storeUserGuilds = (
  session: GuildSessionCache,
  guilds: DiscordGuild[],
) => {
  session.userGuilds = guilds;
  session.userGuildsFetchedAt = Date.now();
  session.guildIds = guilds.map((guild) => guild.id);
  session.guildIdsFetchedAt = session.userGuildsFetchedAt;
};

const getUserGuildsWithCache = async (
  accessToken: string,
  options?: EnsureUserGuildOptions,
) => {
  const cached = getCachedUserGuilds(options?.session);
  if (cached) return cached;
  const guilds = await listUserGuildsCached({
    accessToken,
    userId: options?.userId,
  });
  if (options?.session) {
    storeUserGuilds(options.session, guilds);
  }
  return guilds;
};

const readManageCache = (
  session: GuildSessionCache | undefined,
  guildId: string,
) => {
  if (!session?.manageGuildCache) return null;
  const entry = session.manageGuildCache[guildId];
  if (!entry) return null;
  if (!isCacheFresh(entry.fetchedAt, MANAGE_GUILD_CACHE_TTL_MS)) return null;
  return entry.allowed;
};

const writeManageCache = (
  session: GuildSessionCache | undefined,
  guildId: string,
  allowed: boolean,
) => {
  if (!session) return;
  const cache = session.manageGuildCache ?? {};
  cache[guildId] = { allowed, fetchedAt: Date.now() };
  session.manageGuildCache = cache;
};

const computePermissionsFromRoles = (
  roles: DiscordRole[],
  member: DiscordGuildMember,
  guildId: string,
) => {
  const memberPermissions = parsePermissions(member.permissions);
  if (member.permissions) {
    return memberPermissions;
  }
  const rolePermissions = new Map(
    roles.map((role) => [role.id, parsePermissions(role.permissions)]),
  );
  let permissions = rolePermissions.get(guildId) ?? 0n;
  const memberRoles = member.roles ?? [];
  for (const roleId of memberRoles) {
    permissions |= rolePermissions.get(roleId) ?? 0n;
  }
  return permissions;
};

const checkManageGuildWithBot = async (
  guildId: string,
  userId: string,
): Promise<
  | { status: "ok"; allowed: boolean }
  | { status: "rate_limited" }
  | { status: "unavailable" }
> => {
  try {
    const [roles, member] = await Promise.all([
      listGuildRolesCached(guildId),
      getGuildMemberCached(guildId, userId),
    ]);
    const permissions = computePermissionsFromRoles(roles, member, guildId);
    return { status: "ok", allowed: hasManageGuildPermissions(permissions) };
  } catch (err) {
    if (isDiscordApiError(err) && err.status === 429) {
      console.warn("ensureManageGuildWithUserToken bot rate limited", {
        guildId,
        userId,
      });
      return { status: "rate_limited" };
    }
    if (isDiscordApiError(err) && (err.status === 403 || err.status === 404)) {
      return { status: "unavailable" };
    }
    console.error("ensureManageGuildWithUserToken bot error", err);
    return { status: "unavailable" };
  }
};

export async function ensureManageGuildWithUserToken(
  userAccessToken: string | undefined,
  guildId: string,
  options?: EnsureManageGuildOptions,
): Promise<boolean | null> {
  if (!userAccessToken) return false;
  const session = options?.session;
  const cachedManage = readManageCache(session, guildId);
  if (cachedManage != null) {
    return cachedManage;
  }
  const cachedUserGuilds = getCachedUserGuilds(session);
  if (cachedUserGuilds) {
    const allowed = resolveManageFromUserGuilds(cachedUserGuilds, guildId);
    writeManageCache(session, guildId, allowed);
    return allowed;
  }
  if (options?.userId) {
    const botCheck = await checkManageGuildWithBot(guildId, options.userId);
    if (botCheck.status === "rate_limited") {
      return null;
    }
    if (botCheck.status === "ok") {
      if (botCheck.allowed) {
        writeManageCache(session, guildId, true);
        return true;
      }
    }
  }
  try {
    const guilds = await getUserGuildsWithCache(userAccessToken, {
      session,
      userId: options?.userId,
    });
    const allowed = resolveManageFromUserGuilds(guilds, guildId);
    writeManageCache(session, guildId, allowed);
    return allowed;
  } catch (err) {
    if (isDiscordApiError(err) && err.status === 429) {
      console.warn("ensureManageGuildWithUserToken rate limited", { guildId });
      return null;
    }
    console.error("ensureManageGuildWithUserToken error", err);
    return false;
  }
}

/**
 * Administrator (or guild ownership), which is strictly stronger than Manage
 * Server. Manage Server does not imply access to any particular channel, so a
 * manager who is denied a private channel must not be able to delegate reads of
 * it. Administrator reaches every channel already, so anything it delegates is
 * something the delegator could read directly.
 */
export async function ensureGuildAdministratorWithUserToken(
  userAccessToken: string | undefined,
  guildId: string,
  options?: EnsureUserGuildOptions,
): Promise<boolean | null> {
  if (!userAccessToken) return false;
  try {
    const guilds = await getUserGuildsWithCache(userAccessToken, options);
    const target = guilds.find((guild) => guild.id === guildId);
    if (!target) return false;
    if (target.owner) return true;
    return (parsePermissions(target.permissions) & ADMIN) !== 0n;
  } catch (err) {
    if (isDiscordApiError(err) && err.status === 429) {
      console.warn("ensureGuildAdministratorWithUserToken rate limited", {
        guildId,
      });
      return null;
    }
    console.error("ensureGuildAdministratorWithUserToken error", err);
    return false;
  }
}

export async function ensureUserInGuild(
  userAccessToken: string | undefined,
  guildId: string,
  options?: EnsureUserGuildOptions,
): Promise<boolean | null> {
  if (!userAccessToken) return false;
  const cachedGuildIds = getCachedGuildIds(options?.session);
  if (cachedGuildIds) {
    return cachedGuildIds.includes(guildId);
  }
  try {
    const guilds = await getUserGuildsWithCache(userAccessToken, {
      session: options?.session,
      userId: options?.userId,
    });
    const ok = guilds.some((g) => g.id === guildId);
    if (!ok) {
      console.warn("ensureUserInGuild missing guild", {
        guildId,
        guildCount: guilds.length,
        sample: guilds.slice(0, 5).map((g) => g.id),
      });
    }
    return ok;
  } catch (err) {
    if (isDiscordApiError(err) && err.status === 429) {
      console.warn("ensureUserInGuild rate limited", { guildId });
      return null;
    }
    console.error("ensureUserInGuild error", err);
    return false;
  }
}

export async function ensureBotInGuild(
  guildId: string,
): Promise<boolean | null> {
  try {
    const guilds = await listBotGuildsCached();
    return guilds.some((g) => g.id === guildId);
  } catch (err) {
    if (isDiscordApiError(err) && err.status === 429) {
      console.warn("ensureBotInGuild rate limited", { guildId });
      return null;
    }
    console.error("ensureBotInGuild error", err);
    return false;
  }
}
