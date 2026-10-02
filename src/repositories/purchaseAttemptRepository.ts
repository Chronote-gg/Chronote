import { randomUUID } from "node:crypto";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import { readPurchaseAttempt, compareAndWritePurchaseAttempt } from "../db";
import type { GuildSubscription } from "../types/db";
import type { PurchaseAttempt, PurchaseIncident } from "../types/purchase";

export function purchaseKey(guildId: string): string {
  if (!/^\d{17,20}$/.test(guildId))
    throw new Error("Invalid purchase guild ID");
  return `PURCHASE#${guildId}`;
}
export function incidentKey(
  guildId: string,
  mode: string,
  a: string,
  b: string,
): string {
  return `${purchaseKey(guildId)}#DUPLICATE#${mode}#${[a, b].sort().join("#")}`;
}
export const getPurchaseRepository = () => ({
  async get(guildId: string): Promise<PurchaseAttempt | undefined> {
    purchaseKey(guildId);
    return config.mock.enabled
      ? structuredClone(getMockStore().purchaseAttempts.get(guildId))
      : readPurchaseAttempt(guildId);
  },
  async compareAndWrite(
    next: PurchaseAttempt,
    expected: PurchaseAttempt | undefined,
    pointer: GuildSubscription | undefined,
    incident?: PurchaseIncident,
  ): Promise<boolean> {
    purchaseKey(next.guildId);
    if (!config.mock.enabled)
      return compareAndWritePurchaseAttempt(next, expected, pointer, incident);
    const store = getMockStore();
    const current = store.purchaseAttempts.get(next.guildId);
    const subscription = store.subscriptions.get(next.guildId);
    if (
      current?.revision !== expected?.revision ||
      Boolean(subscription) !== Boolean(pointer) ||
      subscription?.stripeSubscriptionId !== pointer?.stripeSubscriptionId ||
      subscription?.stripeSyncRevision !== pointer?.stripeSyncRevision
    )
      return false;
    store.purchaseAttempts.set(next.guildId, structuredClone(next));
    if (incident) {
      const prior = store.purchaseIncidents.get(incident.key);
      store.purchaseIncidents.set(
        incident.key,
        structuredClone({
          ...incident,
          firstObservedAt: prior?.firstObservedAt ?? incident.firstObservedAt,
          incomingAttemptId:
            prior?.incomingAttemptId ?? incident.incomingAttemptId,
        }),
      );
    }
    return true;
  },
});
export function advanceAttempt(
  attempt: PurchaseAttempt,
  change: Partial<PurchaseAttempt>,
): PurchaseAttempt {
  return { ...attempt, ...change, revision: randomUUID() };
}
