import { jest } from "@jest/globals";
import { getMockStore } from "../../src/repositories/mockStore";
import * as provider from "../../src/services/billingChangeProvider";
import { changeOperation, changePointer } from "./billingChange";
import { renewalStripeClientFixture } from "./renewalStripeClient";

export function pendingFundingChange(guildId = changeOperation.guildId) {
  const client = renewalStripeClientFixture();
  const operation = {
    ...changeOperation,
    guildId,
    source: {
      ...changeOperation.source,
      fingerprint: provider.changeSourceFingerprint(client.provider),
    },
  };
  const store = getMockStore();
  store.subscriptions.set(guildId, { ...changePointer, guildId });
  const key = `CHANGE_OP#${guildId}#${operation.operationId}`;
  store.billingChangeOperations.set(key, operation);
  store.billingChangeControls.set(`CHANGE_CONTROL#${guildId}`, {
    operationId: operation.operationId,
  });
  jest
    .spyOn(provider, "readBillingChangeSource")
    .mockResolvedValue({ subscription: client.provider } as Awaited<
      ReturnType<typeof provider.readBillingChangeSource>
    >);
  return { client, operation, store, key };
}
