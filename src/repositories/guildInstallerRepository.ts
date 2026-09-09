import {
  deleteGuildInstaller,
  getGuildInstaller,
  writeGuildInstaller,
  writeGuildInstallerIfAbsent,
  writeGuildInstallerForMembership,
} from "../db";
import { config } from "../services/configService";
import type { GuildInstaller } from "../types/db";
import { getMockStore } from "./mockStore";

export type GuildInstallerRepository = {
  get: (guildId: string) => Promise<GuildInstaller | undefined>;
  write: (installer: GuildInstaller) => Promise<void>;
  writeIfAbsent: (installer: GuildInstaller) => Promise<boolean>;
  writeForMembership: (
    installer: GuildInstaller,
    joinedAt: string,
  ) => Promise<boolean>;
  remove: (guildId: string, removedAt: string) => Promise<void>;
};

const realRepository: GuildInstallerRepository = {
  get: getGuildInstaller,
  remove: deleteGuildInstaller,
  write: writeGuildInstaller,
  writeIfAbsent: writeGuildInstallerIfAbsent,
  writeForMembership: writeGuildInstallerForMembership,
};

const mockRepository: GuildInstallerRepository = {
  async get(guildId) {
    return getMockStore().guildInstallers.get(guildId);
  },
  async remove(guildId, removedAt) {
    const installers = getMockStore().guildInstallers;
    const installer = installers.get(guildId);
    if (installer && installer.installedAt <= removedAt) {
      installers.delete(guildId);
    }
  },
  async write(installer) {
    getMockStore().guildInstallers.set(installer.guildId, installer);
  },
  async writeForMembership(installer, joinedAt) {
    const installers = getMockStore().guildInstallers;
    const current = installers.get(installer.guildId);
    if (current && current.installedAt >= joinedAt) return false;
    installers.set(installer.guildId, installer);
    return true;
  },
  async writeIfAbsent(installer) {
    const installers = getMockStore().guildInstallers;
    if (installers.has(installer.guildId)) return false;
    installers.set(installer.guildId, installer);
    return true;
  },
};

export function getGuildInstallerRepository(): GuildInstallerRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
