import { config } from "../services/configService";
import {
  getGuildSubscription,
  writeGuildSubscription,
  compareAndWriteGuildSubscription,
} from "../db";
import type { GuildSubscription } from "../types/db";
import { getMockStore } from "./mockStore";

export type SubscriptionRepository = {
  get: (guildId: string) => Promise<GuildSubscription | undefined>;
  write: (subscription: GuildSubscription) => Promise<void>;
  compareAndWrite: (
    subscription: GuildSubscription,
    expected: GuildSubscription | undefined,
  ) => Promise<boolean>;
};

const realRepository: SubscriptionRepository = {
  get: getGuildSubscription,
  write: writeGuildSubscription,
  compareAndWrite: compareAndWriteGuildSubscription,
};

const mockRepository: SubscriptionRepository = {
  async get(guildId) {
    return getMockStore().subscriptions.get(guildId);
  },
  async write(subscription) {
    getMockStore().subscriptions.set(subscription.guildId, subscription);
  },
  async compareAndWrite(subscription, expected) {
    const current = getMockStore().subscriptions.get(subscription.guildId);
    if (
      Boolean(current) !== Boolean(expected) ||
      current?.stripeSubscriptionId !== expected?.stripeSubscriptionId ||
      current?.stripeSyncRevision !== expected?.stripeSyncRevision
    )
      return false;
    getMockStore().subscriptions.set(subscription.guildId, subscription);
    return true;
  },
};

export function getSubscriptionRepository(): SubscriptionRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
