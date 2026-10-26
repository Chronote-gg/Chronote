import type { ConfigOverrideRecord } from "../types/db";
import {
  deleteConfigOverride,
  getConfigOverride,
  listConfigOverrides,
  scanConfigOverridesByScopePrefix,
  writeConfigOverride,
} from "../db";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";

export type ConfigOverridesRepository = {
  get: (
    scopeId: string,
    configKey: string,
  ) => Promise<ConfigOverrideRecord | undefined>;
  listByScope: (
    scopeId: string,
    signal?: AbortSignal,
  ) => Promise<ConfigOverrideRecord[]>;
  listByScopePrefix: (scopePrefix: string) => Promise<ConfigOverrideRecord[]>;
  write: (record: ConfigOverrideRecord) => Promise<void>;
  remove: (scopeId: string, configKey: string) => Promise<void>;
};

const realRepository: ConfigOverridesRepository = {
  get: getConfigOverride,
  listByScope: listConfigOverrides,
  listByScopePrefix: scanConfigOverridesByScopePrefix,
  write: writeConfigOverride,
  remove: deleteConfigOverride,
};

const mockRepository: ConfigOverridesRepository = {
  async get(scopeId, configKey) {
    const record = getMockStore().configOverrides.get(
      `${scopeId}#${configKey}`,
    );
    return record;
  },
  async listByScope(scopeId, signal) {
    signal?.throwIfAborted();
    const items = Array.from(getMockStore().configOverrides.values()).filter(
      (record) => record.scopeId === scopeId,
    );
    return items;
  },
  async listByScopePrefix(scopePrefix) {
    const items = Array.from(getMockStore().configOverrides.values()).filter(
      (record) => record.scopeId.startsWith(scopePrefix),
    );
    return items;
  },
  async write(record) {
    getMockStore().configOverrides.set(
      `${record.scopeId}#${record.configKey}`,
      record,
    );
  },
  async remove(scopeId, configKey) {
    getMockStore().configOverrides.delete(`${scopeId}#${configKey}`);
  },
};

export function getConfigOverridesRepository(): ConfigOverridesRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
