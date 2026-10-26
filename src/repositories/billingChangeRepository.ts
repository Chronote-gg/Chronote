import { z } from "zod";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import {
  readRenewalRecord,
  claimBillingChangeOperation,
  writeBillingChangeOperation,
} from "../db";
import { renewalControlKey } from "../types/renewal";
import {
  offerUsageSchema,
  offerUsageKey,
  type OfferUsageMutation,
} from "../types/offerUsage";
import { matchesMockOfferAuthority } from "./offerUsageRepository";
import {
  billingChangeOperationKey,
  billingChangeControlKey,
  billingChangeOperationSchema,
  assertBillingChangeTransition,
  isBillingChangeComplete,
  parseChangeUsage,
  type BillingChangeClaim,
  type BillingChangeWrite,
  type BillingChangeOperation,
} from "../types/billingChange";

function mockUsageAllowed(
  mutation: OfferUsageMutation,
  operation: BillingChangeOperation,
) {
  const { next, expected, authority } = parseChangeUsage(operation, mutation);
  const current = getMockStore().offerUsages.get(
    offerUsageKey(next.guildId, next.offerId, next.mode),
  );
  return (
    current?.revision === expected?.revision &&
    (!authority || matchesMockOfferAuthority(authority))
  );
}
function saveMockUsage(mutation: OfferUsageMutation | undefined) {
  if (!mutation) return;
  const next = offerUsageSchema.parse(mutation.next);
  getMockStore().offerUsages.set(
    offerUsageKey(next.guildId, next.offerId, next.mode),
    structuredClone(next),
  );
}
function claimMatchesPointer(
  next: BillingChangeOperation,
  input: BillingChangeClaim,
) {
  return (
    next.state === "preparing" &&
    input.expectedSubscription.guildId === next.guildId &&
    input.expectedSubscription.stripeSubscriptionId ===
      next.source.subscriptionId &&
    (input.expectedSubscription.stripeSyncRevision ?? null) ===
      next.source.revision
  );
}
function mockClaimAvailable(
  next: BillingChangeOperation,
  input: BillingChangeClaim,
) {
  const store = getMockStore();
  const pointer = store.subscriptions.get(next.guildId);
  return Boolean(
    pointer &&
    pointer.stripeSubscriptionId ===
      input.expectedSubscription.stripeSubscriptionId &&
    pointer.stripeSyncRevision ===
      input.expectedSubscription.stripeSyncRevision &&
    !store.renewalRecoveryPointers.get(next.guildId)?.blocking &&
    !store.billingChangeControls.has(billingChangeControlKey(next.guildId)) &&
    !["preparing", "open", "needs_review"].includes(
      store.purchaseAttempts.get(next.guildId)?.state ?? "",
    ) &&
    !store.billingChangeOperations.has(
      billingChangeOperationKey(next.guildId, next.operationId),
    ) &&
    !store.renewalControls.has(renewalControlKey(next.guildId)) &&
    (!input.usage || mockUsageAllowed(input.usage, next)),
  );
}
function assertAtomicSettlement(
  next: BillingChangeOperation,
  previous: BillingChangeOperation,
  usage: BillingChangeWrite["usage"],
) {
  if (
    next.target.offer &&
    ["succeeded", "canceled"].includes(next.state) &&
    previous.state !== next.state &&
    !usage
  )
    throw new Error("Terminal offer settlement must be atomic");
}
export function getBillingChangeRepository() {
  return {
    async getControl(
      guildId: string,
    ): Promise<{ operationId: string } | undefined> {
      const key = billingChangeControlKey(guildId);
      if (config.mock.enabled)
        return structuredClone(getMockStore().billingChangeControls.get(key));
      const record = await readRenewalRecord(key);
      return record
        ? z.object({ operationId: z.uuid() }).parse(record)
        : undefined;
    },
    async getOperation(
      guildId: string,
      operationId: string,
    ): Promise<BillingChangeOperation | undefined> {
      const key = billingChangeOperationKey(guildId, operationId);
      if (config.mock.enabled)
        return structuredClone(getMockStore().billingChangeOperations.get(key));
      const record = await readRenewalRecord(key);
      return record
        ? billingChangeOperationSchema.parse({ ...record, guildId })
        : undefined;
    },
    async claim(input: BillingChangeClaim): Promise<boolean> {
      const next = billingChangeOperationSchema.parse(input.operation);
      if (!claimMatchesPointer(next, input)) return false;
      if (input.usage) parseChangeUsage(next, input.usage);
      if (Boolean(next.target.offer) !== Boolean(input.usage))
        throw new Error("Offer reservation must be atomic");
      if (!config.mock.enabled) return claimBillingChangeOperation(input);
      const store = getMockStore();
      const key = billingChangeOperationKey(next.guildId, next.operationId);
      const control = billingChangeControlKey(next.guildId);
      if (!mockClaimAvailable(next, input)) return false;
      store.billingChangeOperations.set(key, structuredClone(next));
      store.billingChangeControls.set(control, {
        operationId: next.operationId,
      });
      saveMockUsage(input.usage);
      return true;
    },
    async compareAndWrite(input: BillingChangeWrite): Promise<boolean> {
      const next = billingChangeOperationSchema.parse(input.next);
      const previous = await this.getOperation(next.guildId, next.operationId);
      if (!previous || previous.revision !== input.expectedRevision)
        return false;
      assertBillingChangeTransition(next, previous);
      if (input.usage) parseChangeUsage(next, input.usage);
      assertAtomicSettlement(next, previous, input.usage);
      if (!config.mock.enabled) return writeBillingChangeOperation(input);
      const store = getMockStore();
      const key = billingChangeOperationKey(next.guildId, next.operationId);
      const control = billingChangeControlKey(next.guildId);
      if (
        store.billingChangeOperations.get(key)?.revision !==
          input.expectedRevision ||
        store.billingChangeControls.get(control)?.operationId !==
          next.operationId ||
        (input.usage && !mockUsageAllowed(input.usage, next))
      )
        return false;
      store.billingChangeOperations.set(key, structuredClone(next));
      if (isBillingChangeComplete(next))
        store.billingChangeControls.delete(control);
      saveMockUsage(input.usage);
      return true;
    },
  };
}
