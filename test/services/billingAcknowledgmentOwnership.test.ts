/** @jest-environment node */
import "../deployment/coldNetworkGuard.cjs";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { context, control, runtime } from "../deployment/controlFixtures";
import { getRuntimeWorkAdmissionCheckpoints } from "../../src/services/runtimeWorkAdmissionService";
import { readBillingChange } from "../../src/services/billingChangeService";
import * as changeRepository from "../../src/repositories/billingChangeRepository";
import * as renewalRepository from "../../src/repositories/renewalReactivationRepository";
import {
  readRenewalState,
  restoreRenewal,
} from "../../src/services/renewalReactivationService";
import { pendingFundingChange } from "../fixtures/pendingFundingChange";
import {
  renewalGuildId,
  renewalPayerId,
  renewalSubscription,
} from "../fixtures/renewal";
import {
  renewalStripeClientFixture,
  response,
} from "../fixtures/renewalStripeClient";
import { fundedInvoice, sourceSubscription } from "../fixtures/renewalStripe";
import { UnresolvedBillingMutation } from "../../src/services/runtimeBillingOperationService";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
  getRuntimeAdmissionContext: async () => context,
}));
const original = {
  mock: config.mock.enabled,
  renewal: config.stripe.renewalReactivationEnabled,
};
beforeEach(() => {
  config.mock.enabled = true;
  config.stripe.renewalReactivationEnabled = true;
  resetMockStore();
  for (const row of [control, runtime("old")])
    getMockStore().deploymentControlRecords.set(
      JSON.stringify([row.pk, row.sk]),
      structuredClone(row),
    );
});
afterEach(() => {
  jest.restoreAllMocks();
  config.mock.enabled = original.mock;
  config.stripe.renewalReactivationEnabled = original.renewal;
});

test("an acknowledged funding invoice with a losing receipt CAS retains the actual API owner", async () => {
  const { client: f, operation, store, key } = pendingFundingChange();
  const create = jest.spyOn(f.stripe.invoices, "create").mockResolvedValue(
    response({
      ...fundedInvoice,
      id: "in_ack_missing_receipt",
      status: "draft",
      customer: operation.source.customerId,
      auto_advance: false,
      parent: null,
      metadata: {
        guild_id: operation.guildId,
        chronote_change_operation: operation.operationId,
        chronote_invoice_role: "funding",
      },
    }),
  );
  const repository = changeRepository.getBillingChangeRepository();
  jest
    .spyOn(changeRepository, "getBillingChangeRepository")
    .mockReturnValue(repository);
  jest.spyOn(repository, "compareAndWrite").mockImplementationOnce(async () => {
    store.billingChangeOperations.set(key, {
      ...operation,
      revision: "concurrent-without-receipt",
    });
    return false;
  });
  const prior = getRuntimeWorkAdmissionCheckpoints().length;
  await expect(
    readBillingChange({
      stripe: f.stripe,
      guildId: operation.guildId,
      payerId: operation.payerId,
      now: operation.createdAt,
    }),
  ).rejects.toBeInstanceOf(UnresolvedBillingMutation);
  expect(create).toHaveBeenCalledTimes(1);
  expect(store.billingChangeOperations.get(key)).toMatchObject({
    revision: "concurrent-without-receipt",
    draftInvoiceId: null,
  });
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(prior + 1);
});

test.each(["throw", "false"])(
  "renewal ACK with %s verifying receipt retains its original API owner",
  async (failure) => {
    const f = renewalStripeClientFixture();
    const now = sourceSubscription.created * 1000 + 60000;
    getMockStore().subscriptions.set(renewalGuildId, {
      ...renewalSubscription,
      stripeCustomerId: "cus_renewal",
    });
    const view = await readRenewalState({
      stripe: f.stripe,
      guildId: renewalGuildId,
      payerId: renewalPayerId,
      now,
    });
    if (view.state.kind !== "off" || view.state.action.kind !== "ready")
      throw new Error("Expected synthetic consent");
    const repository = renewalRepository.getRenewalReactivationRepository();
    jest
      .spyOn(renewalRepository, "getRenewalReactivationRepository")
      .mockReturnValue(repository);
    const write = repository.compareAndWrite.bind(repository);
    jest
      .spyOn(repository, "compareAndWrite")
      .mockImplementation(async (input) => {
        if (input.next.state !== "verifying") return write(input);
        if (failure === "throw")
          throw new Error("Synthetic receipt unavailable");
        return false;
      });
    const prior = getRuntimeWorkAdmissionCheckpoints().length;
    await expect(
      restoreRenewal({
        stripe: f.stripe,
        guildId: renewalGuildId,
        payerId: renewalPayerId,
        now,
        analyticsOptOut: true,
        request: { kind: "confirm", quoteToken: view.state.action.quoteToken },
      }),
    ).rejects.toBeInstanceOf(UnresolvedBillingMutation);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect([...getMockStore().renewalOperations.values()][0].state).toBe(
      "applying",
    );
    expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(prior + 1);
  },
);
