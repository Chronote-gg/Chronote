import { billingChangeControlKey } from "../types/billingChange";
import { matchesMockOfferAuthority } from "./offerUsageRepository";
import { assertPurchaseInvoiceBinding } from "../types/purchase";
import {
  parseOfferUsageChange,
  offerUsageKey,
  type OfferUsageMutation,
} from "../types/offerUsage";
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
function isBlockedNewPurchase(
  next: PurchaseAttempt,
  expected: PurchaseAttempt | undefined,
) {
  return (
    next.state === "preparing" &&
    next.attemptId !== expected?.attemptId &&
    (getMockStore().renewalRecoveryPointers.get(next.guildId)?.blocking ||
      getMockStore().billingChangeControls.has(
        billingChangeControlKey(next.guildId),
      ))
  );
}
function recordMockIncident(incident: PurchaseIncident | undefined) {
  if (!incident) return;
  const store = getMockStore();
  const prior = store.purchaseIncidents.get(incident.key);
  store.purchaseIncidents.set(
    incident.key,
    structuredClone({
      ...incident,
      firstObservedAt: prior?.firstObservedAt ?? incident.firstObservedAt,
      incomingAttemptId: prior?.incomingAttemptId ?? incident.incomingAttemptId,
    }),
  );
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
    offerUsage?: OfferUsageMutation,
  ): Promise<boolean> {
    purchaseKey(next.guildId);
    assertPurchaseInvoiceBinding(next, expected);
    const usage =
      offerUsage &&
      parseOfferUsageChange({ ...offerUsage, pointer, operation: next });
    if (!config.mock.enabled)
      return compareAndWritePurchaseAttempt(
        next,
        expected,
        pointer,
        incident,
        offerUsage,
      );
    const store = getMockStore();
    const current = store.purchaseAttempts.get(next.guildId);
    const subscription = store.subscriptions.get(next.guildId);
    if (isBlockedNewPurchase(next, expected)) return false;
    if (
      current?.revision !== expected?.revision ||
      Boolean(subscription) !== Boolean(pointer) ||
      subscription?.stripeSubscriptionId !== pointer?.stripeSubscriptionId ||
      subscription?.stripeSyncRevision !== pointer?.stripeSyncRevision
    )
      return false;
    if (usage && !writeMockUsage(usage)) return false;
    store.purchaseAttempts.set(next.guildId, structuredClone(next));
    recordMockIncident(incident);
    return true;
  },
});
export function advanceAttempt(
  attempt: PurchaseAttempt,
  change: Partial<PurchaseAttempt>,
): PurchaseAttempt {
  return { ...attempt, ...change, revision: randomUUID() };
}

function writeMockUsage(
  usage: ReturnType<typeof parseOfferUsageChange>,
): boolean {
  if (usage.authority && !matchesMockOfferAuthority(usage.authority))
    return false;
  const store = getMockStore();
  const key = offerUsageKey(
    usage.next.guildId,
    usage.next.offerId,
    usage.next.mode,
  );
  if (store.offerUsages.get(key)?.revision !== usage.expected?.revision)
    return false;
  store.offerUsages.set(key, structuredClone(usage.next));
  return true;
}
