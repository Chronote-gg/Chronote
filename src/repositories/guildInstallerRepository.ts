import {
  getGuildInstaller,
  writeGuildInstaller,
  writeGuildInstallerIfAbsent,
} from "../db";
import { config } from "../services/configService";
import type { GuildInstaller } from "../types/db";
import { getMockStore } from "./mockStore";

export type GuildInstallerRepository = {
  get: (guildId: string) => Promise<GuildInstaller | undefined>;
  write: (installer: GuildInstaller) => Promise<void>;
  writeIfAbsent: (installer: GuildInstaller) => Promise<boolean>;
};

const realRepository: GuildInstallerRepository = {
  get: getGuildInstaller,
  write: writeGuildInstaller,
  writeIfAbsent: writeGuildInstallerIfAbsent,
};

const mockRepository: GuildInstallerRepository = {
  async get(guildId) {
    return getMockStore().guildInstallers.get(guildId);
  },
  async write(installer) {
    getMockStore().guildInstallers.set(installer.guildId, installer);
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
