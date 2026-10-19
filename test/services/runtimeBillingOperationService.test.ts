/** @jest-environment node */
import Stripe from "stripe";
import {
  runBillingOperation,
  type RuntimeBillingOwner,
} from "../../src/services/runtimeBillingOperationService";
import {
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
const mockSettled = jest.fn();
const mockCheckAdmission = jest.fn();
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => ({
    checkAdmission: mockCheckAdmission,
  }),
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ transition: jest.fn(), settle: mockSettled }),
  getRuntimeAdmissionContext: async () => ({ instanceId: "billing-test" }),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAdmission.mockResolvedValue({ kind: "admitted" });
});
test("held billing refuses before durable or provider work", async () => {
  mockCheckAdmission.mockResolvedValue({
    kind: "blocked",
    reason: "maintenance",
  });
  const run = jest.fn();
  await expect(runBillingOperation(undefined, run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
test("only the original registered owner can join and it expires after settlement", async () => {
  let captured!: RuntimeBillingOwner;
  await runBillingOperation(undefined, async (owner) => {
    captured = owner;
    await runBillingOperation(owner, async (nested) =>
      expect(nested).toBe(owner),
    );
  });
  expect(mockCheckAdmission).toHaveBeenCalledTimes(1);
  const run = jest.fn();
  await expect(runBillingOperation(captured, run)).rejects.toThrow();
  await expect(runBillingOperation({ ...captured }, run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
test.each([true, false])(
  "provider rejection known=%s keeps exact outcome semantics",
  async (known) => {
    const before = getRuntimeWorkAdmissionCheckpoints().length;
    const error = known
      ? new Stripe.errors.StripeInvalidRequestError({
          message: "definite rejection",
          statusCode: 400,
        })
      : new Error("response lost");
    await expect(
      runBillingOperation(undefined, async () => {
        throw error;
      }),
    ).rejects.toThrow();
    expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(
      before + (known ? 0 : 1),
    );
    expect(mockSettled).toHaveBeenCalledTimes(known ? 1 : 0);
  },
);
test("known acknowledgement persists its receipt after abort before owner settlement", async () => {
  const order: string[] = [];
  await runBillingOperation(undefined, async (owner) => {
    await owner.effect(async () => {
      order.push("ack");
      fenceRuntimeWorkAdmissions();
      return "provider-id";
    });
    order.push("receipt");
    expect(mockSettled).not.toHaveBeenCalled();
  });
  expect(order).toEqual(["ack", "receipt"]);
  expect(mockSettled).toHaveBeenCalledTimes(1);
});

test.each([
  "checkout",
  "portal",
  "restore",
  "prepare",
  "confirm",
  "cancel",
  "query",
  "webhook",
  "cancelRenewal",
  "cancelScheduled",
  "reconcile",
])("direct %s entry cannot bypass held admission", async (entry) => {
  const { config } = await import("../../src/services/configService");
  const { getMockStore, resetMockStore } =
    await import("../../src/repositories/mockStore");
  const { changeOperation } = await import("../fixtures/billingChange");
  const billing = await import("../../src/services/billingService");
  const changes = await import("../../src/services/billingChangeService");
  const renewal = await import("../../src/services/renewalReactivationService");
  const recovery = await import("../../src/services/renewalRecoveryService");
  const { stripeTransport } = await import("../fixtures/stripeTransport");
  const provider = jest.fn(() => {
    throw new Error("Unexpected provider dispatch");
  });
  const { stripe } = stripeTransport(provider);
  const previous = config.mock.enabled;
  config.mock.enabled = true;
  resetMockStore();
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${changeOperation.guildId}#${changeOperation.operationId}`,
    changeOperation,
  );
  getMockStore().billingChangeControls.set(
    `CHANGE_CONTROL#${changeOperation.guildId}`,
    { operationId: changeOperation.operationId },
  );
  mockCheckAdmission.mockResolvedValue({
    kind: "blocked",
    reason: "maintenance",
  });
  const context = {
    stripe,
    guildId: changeOperation.guildId,
    payerId: changeOperation.payerId,
    now: 100,
  };
  const calls: Record<string, () => Promise<unknown>> = {
    checkout: () =>
      billing.createCheckoutSession({
        stripe,
        guildId: context.guildId,
        user: { id: context.payerId },
      }),
    portal: () =>
      billing.createPortalSession({
        stripe,
        guildId: context.guildId,
        user: { id: context.payerId },
      }),
    restore: () =>
      renewal.restoreRenewal({
        ...context,
        request: { kind: "recover", operationId: "old" },
        analyticsOptOut: false,
      }),
    prepare: () =>
      changes.prepareBillingChange({
        ...context,
        selection: { tier: "basic", interval: "month" },
      }),
    confirm: () =>
      changes.confirmBillingChange({
        ...context,
        operationId: "old",
        revision: "old",
      }),
    cancel: () =>
      changes.cancelBillingChange({ ...context, operationId: "old" }),
    query: () => changes.readBillingChange(context),
    webhook: () =>
      changes.reconcileBillingChangeForWebhook(stripe, context.guildId),
    cancelRenewal: () => recovery.cancelRenewalRecovery(context),
    cancelScheduled: () =>
      recovery.cancelScheduledRenewalRecovery({
        ...context,
        operationId: "old",
      }),
    reconcile: () => recovery.reconcileRenewalRecovery(context),
  };
  try {
    await expect(calls[entry]()).rejects.toThrow("accepting");
    expect(provider).not.toHaveBeenCalled();
    expect(mockCheckAdmission).toHaveBeenCalledTimes(1);
  } finally {
    config.mock.enabled = previous;
  }
});
