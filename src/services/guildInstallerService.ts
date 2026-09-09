import { ensureManageGuildWithBotFresh } from "./guildAccessService";
import { config } from "./configService";
import { getGuildMember } from "./discordService";
import type { GuildInstaller } from "../types/db";
import { getGuildInstallerRepository } from "../repositories/guildInstallerRepository";

export async function fetchGuildInstaller(guildId: string) {
  return getGuildInstallerRepository().get(guildId);
}

export async function saveGuildInstaller(installer: GuildInstaller) {
  return getGuildInstallerRepository().write(installer);
}

export async function saveGuildInstallerIfAbsent(installer: GuildInstaller) {
  return getGuildInstallerRepository().writeIfAbsent(installer);
}

export async function removeGuildInstaller(guildId: string, removedAt: string) {
  return getGuildInstallerRepository().remove(guildId, removedAt);
}

export async function fetchGuildInstallerForMembership(
  guildId: string,
  joinedTimestamp: number | null,
) {
  if (joinedTimestamp === null || !Number.isFinite(joinedTimestamp))
    return undefined;
  const installer = await fetchGuildInstaller(guildId);
  return installer && Date.parse(installer.installedAt) >= joinedTimestamp
    ? installer
    : undefined;
}

export async function saveGuildInstallerForCurrentMembership(
  installer: GuildInstaller,
) {
  if (
    !(await ensureManageGuildWithBotFresh(
      installer.guildId,
      installer.installerId,
    ))
  ) {
    throw new Error(
      "Installer must have Manage Guild permission in the target guild",
    );
  }
  const member = await getGuildMember(
    installer.guildId,
    config.discord.clientId,
  );
  return saveGuildInstallerForMembership(
    installer,
    Date.parse(member.joined_at ?? ""),
  );
}

export async function saveGuildInstallerForMembership(
  installer: GuildInstaller,
  joinedTimestamp: number | null,
) {
  if (joinedTimestamp === null || !Number.isFinite(joinedTimestamp)) {
    throw new Error(
      "Discord bot membership join timestamp is missing or invalid",
    );
  }
  const installedTimestamp = Date.parse(installer.installedAt);
  if (!Number.isFinite(installedTimestamp)) {
    throw new Error("Installer timestamp is invalid");
  }
  // Use canonical millisecond ISO strings for Dynamo comparisons. Discord may
  // return microseconds, and local clock skew must not predate this membership.
  return getGuildInstallerRepository().writeForMembership(
    {
      ...installer,
      installedAt: new Date(
        Math.max(installedTimestamp, joinedTimestamp),
      ).toISOString(),
    },
    new Date(joinedTimestamp).toISOString(),
  );
}
