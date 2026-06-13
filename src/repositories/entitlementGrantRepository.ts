import { config } from "../services/configService";
import {
  getEntitlementGrant,
  listActiveEntitlementGrantsForGuild,
  listEntitlementGrants,
  revokeEntitlementGrant,
  writeEntitlementGrant,
} from "../db";
import type { EntitlementGrant, EntitlementGrantStatus } from "../types/db";
import { getMockStore } from "./mockStore";

export type ListEntitlementGrantFilters = {
  guildId?: string;
  status?: EntitlementGrantStatus;
  limit?: number;
};

export type RevokeEntitlementGrantParams = {
  grantId: string;
  revokedAt: string;
  revokedBy: string;
  revocationReason: string;
  autoRevokedByStripeSubscriptionId?: string;
};

export type EntitlementGrantRepository = {
  get: (grantId: string) => Promise<EntitlementGrant | undefined>;
  list: (filters?: ListEntitlementGrantFilters) => Promise<EntitlementGrant[]>;
  listActiveForGuild: (guildId: string) => Promise<EntitlementGrant[]>;
  write: (grant: EntitlementGrant) => Promise<void>;
  revoke: (params: RevokeEntitlementGrantParams) => Promise<void>;
};

const sortNewestFirst = (items: EntitlementGrant[]) =>
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

const realRepository: EntitlementGrantRepository = {
  get: getEntitlementGrant,
  async list(filters) {
    const items = await listEntitlementGrants(filters);
    return sortNewestFirst(items);
  },
  listActiveForGuild: listActiveEntitlementGrantsForGuild,
  write: writeEntitlementGrant,
  revoke: revokeEntitlementGrant,
};

const mockRepository: EntitlementGrantRepository = {
  async get(grantId) {
    return getMockStore().entitlementGrants.get(grantId);
  },
  async list(filters) {
    const items = [...getMockStore().entitlementGrants.values()].filter(
      (grant) =>
        (!filters?.guildId || grant.guildId === filters.guildId) &&
        (!filters?.status || grant.status === filters.status),
    );
    return sortNewestFirst(items).slice(0, filters?.limit ?? items.length);
  },
  async listActiveForGuild(guildId) {
    return [...getMockStore().entitlementGrants.values()].filter(
      (grant) => grant.guildId === guildId && grant.status === "active",
    );
  },
  async write(grant) {
    getMockStore().entitlementGrants.set(grant.grantId, grant);
  },
  async revoke(params) {
    const store = getMockStore();
    const grant = store.entitlementGrants.get(params.grantId);
    if (!grant) return;
    store.entitlementGrants.set(params.grantId, {
      ...grant,
      status: "revoked",
      updatedAt: params.revokedAt,
      updatedBy: params.revokedBy,
      revokedAt: params.revokedAt,
      revokedBy: params.revokedBy,
      revocationReason: params.revocationReason,
      autoRevokedByStripeSubscriptionId:
        params.autoRevokedByStripeSubscriptionId,
    });
  },
};

export function getEntitlementGrantRepository(): EntitlementGrantRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
