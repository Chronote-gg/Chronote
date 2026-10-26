import { billingChangeControlKey } from "../types/billingChange";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import {
  readRenewalRecord,
  claimRenewalOperation,
  writeRenewalOperation,
} from "../db";
import {
  renewalOperationKey,
  renewalControlKey,
  renewalControlSchema,
  renewalOperationSchema,
  assertRenewalOperationTransition,
  isRenewalComplete,
  type RenewalControl,
  type RenewalOperation,
} from "../types/renewal";
import type { GuildSubscription } from "../types/db";
export function getRenewalReactivationRepository() {
  return {
    async getOperation({
      guildId,
      operationId,
    }: {
      guildId: string;
      operationId: string;
    }): Promise<RenewalOperation | undefined> {
      const key = renewalOperationKey(guildId, operationId);
      if (config.mock.enabled)
        return structuredClone(getMockStore().renewalOperations.get(key));
      const record = await readRenewalRecord(key);
      return record
        ? renewalOperationSchema.parse({ ...record, guildId })
        : undefined;
    },
    async getControl({
      guildId,
    }: {
      guildId: string;
    }): Promise<RenewalControl | undefined> {
      const key = renewalControlKey(guildId);
      if (config.mock.enabled)
        return structuredClone(getMockStore().renewalControls.get(key));
      const record = await readRenewalRecord(key);
      return record
        ? renewalControlSchema.parse({ ...record, guildId })
        : undefined;
    },
    async claim({
      operation,
      expectedSubscription,
    }: {
      operation: RenewalOperation;
      expectedSubscription: GuildSubscription;
    }): Promise<boolean> {
      const next = renewalOperationSchema.parse(operation);
      if (
        next.state !== "applying" ||
        expectedSubscription.guildId !== next.guildId ||
        expectedSubscription.stripeSubscriptionId !== next.subscriptionId ||
        (expectedSubscription.stripeSyncRevision ?? null) !==
          next.sourceRevision
      )
        return false;
      if (!config.mock.enabled)
        return claimRenewalOperation(next, expectedSubscription);
      const store = getMockStore();
      const pointer = store.subscriptions.get(next.guildId);
      const operationKey = renewalOperationKey(next.guildId, next.operationId);
      const controlKey = renewalControlKey(next.guildId);
      const blocked = [
        store.renewalRecoveryPointers.get(next.guildId)?.blocking,
        store.renewalControls.has(controlKey),
        store.billingChangeControls.has(billingChangeControlKey(next.guildId)),
        store.renewalOperations.has(operationKey),
      ].some(Boolean);
      if (
        !pointer ||
        pointer.stripeSubscriptionId !==
          expectedSubscription.stripeSubscriptionId ||
        pointer.stripeSyncRevision !==
          expectedSubscription.stripeSyncRevision ||
        blocked
      )
        return false;
      store.renewalOperations.set(operationKey, structuredClone(next));
      store.renewalControls.set(controlKey, {
        guildId: next.guildId,
        operationId: next.operationId,
        revision: next.revision,
      });
      return true;
    },
    async compareAndWrite({
      next,
      expectedRevision,
    }: {
      next: RenewalOperation;
      expectedRevision: string;
    }): Promise<boolean> {
      const parsed = renewalOperationSchema.parse(next);
      const previous = await this.getOperation({
        guildId: next.guildId,
        operationId: next.operationId,
      });
      if (!previous || previous.revision !== expectedRevision) return false;
      assertRenewalOperationTransition(parsed, previous);
      if (!config.mock.enabled)
        return writeRenewalOperation(parsed, expectedRevision);
      const store = getMockStore();
      const key = renewalOperationKey(next.guildId, next.operationId);
      const controlKey = renewalControlKey(next.guildId);
      if (
        store.renewalOperations.get(key)?.revision !== expectedRevision ||
        store.renewalControls.get(controlKey)?.operationId !== next.operationId
      )
        return false;
      store.renewalOperations.set(key, structuredClone(parsed));
      if (isRenewalComplete(parsed)) store.renewalControls.delete(controlKey);
      return true;
    },
  };
}
