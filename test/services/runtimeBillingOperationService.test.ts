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
      runBillingOperation(undefined, async (owner) =>
        owner.effect(async () => {
          throw error;
        }),
      ),
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

test("a read failure before the first mutation settles normally", async () => {
  const before = getRuntimeWorkAdmissionCheckpoints().length;
  await expect(
    runBillingOperation(undefined, async () => {
      throw new Error("provider GET unavailable");
    }),
  ).rejects.toThrow("provider GET");
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before);
  expect(mockSettled).toHaveBeenCalledTimes(1);
});
test("a receipt failure after acknowledged mutation remains unresolved", async () => {
  const before = getRuntimeWorkAdmissionCheckpoints().length;
  await expect(
    runBillingOperation(undefined, async (owner) => {
      await owner.effect(async () => "ack");
      throw new Error("receipt lost");
    }),
  ).rejects.toThrow("receipt lost");
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before + 1);
  expect(mockSettled).not.toHaveBeenCalled();
});

test.each(["false", "known rejection"])(
  "%s without an earlier write remains a known outcome",
  async (kind) => {
    const { BillingActionError } =
      await import("../../src/services/billingActionError");
    const before = getRuntimeWorkAdmissionCheckpoints().length;
    await expect(
      runBillingOperation(undefined, async (owner) => {
        await owner.effect(async () => {
          if (kind === "known rejection")
            throw new BillingActionError("BAD_REQUEST", "rejected");
          return false;
        });
        expect(owner.mutationStarted()).toBe(false);
        throw new BillingActionError("BAD_REQUEST", "rejected");
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before);
  },
);
test("an earlier acknowledged write survives a later no-write rejection", async () => {
  const { BillingActionError } =
    await import("../../src/services/billingActionError");
  const before = getRuntimeWorkAdmissionCheckpoints().length;
  await expect(
    runBillingOperation(undefined, async (owner) => {
      await owner.effect(async () => undefined);
      await owner.effect(async () => false);
      throw new BillingActionError("BAD_REQUEST", "later CAS rejected");
    }),
  ).rejects.toMatchObject({ cause: { code: "BAD_REQUEST" } });
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before + 1);
});
test.each(["acknowledged", "unknown"])(
  "a detached %s mutation tail cannot be lost on callback failure",
  async (outcome) => {
    const before = getRuntimeWorkAdmissionCheckpoints().length;
    await expect(
      runBillingOperation(undefined, async (owner) => {
        void owner
          .effect(async () => {
            await Promise.resolve();
            if (outcome === "unknown") throw new Error("tail response lost");
          })
          .catch(() => undefined);
        throw new Error("callback failed");
      }),
    ).rejects.toThrow();
    expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before + 1);
  },
);
test.each(["api", "worker"])(
  "%s owner persists an ACK after cancellation but refuses the next dispatch",
  async (kind) => {
    const { persistBillingAcknowledgment, runBillingWorkerOperation } =
      await import("../../src/services/runtimeBillingOperationService");
    const { beginRuntimeWorkClaim } =
      await import("../../src/services/runtimeWorkAdmissionService");
    const controller = new AbortController();
    const persisted = jest.fn(async () => true);
    const provider = jest.fn(async () => undefined);
    const run = async (owner: RuntimeBillingOwner) => {
      await owner.effect(async () => {
        controller.abort();
        if (kind === "api") fenceRuntimeWorkAdmissions();
      });
      await persistBillingAcknowledgment(owner, persisted);
      await expect(owner.effect(provider)).rejects.toThrow();
    };
    if (kind === "api") await runBillingOperation(undefined, run);
    else {
      const work = beginRuntimeWorkClaim("billing", "post-ack-worker");
      await work.trackPromise(async () => {
        await runBillingWorkerOperation(work, controller.signal, run);
        work.acknowledgeDurableBillingRecovery("post-ack-worker");
        await work.settle();
      });
    }
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
  },
);
test("forged and settled owners cannot persist receipts", async () => {
  const { persistBillingAcknowledgment } =
    await import("../../src/services/runtimeBillingOperationService");
  let settled!: RuntimeBillingOwner;
  const write = jest.fn();
  await runBillingOperation(undefined, async (owner) => {
    settled = owner;
    await expect(
      persistBillingAcknowledgment({ ...owner }, write),
    ).rejects.toThrow("registered");
  });
  await expect(persistBillingAcknowledgment(settled, write)).rejects.toThrow(
    "registered",
  );
  expect(write).not.toHaveBeenCalled();
});

test("a raw domain receipt ACK without a provider write retains a later failure", async () => {
  const { persistBillingAcknowledgment } =
    await import("../../src/services/runtimeBillingOperationService");
  const before = getRuntimeWorkAdmissionCheckpoints().length;
  const saved: string[] = [];
  await expect(
    runBillingOperation(undefined, async (owner) => {
      await persistBillingAcknowledgment(owner, async () => {
        saved.push("receipt");
      });
      expect(owner.mutationStarted()).toBe(true);
      throw new Error("read after receipt failed");
    }),
  ).rejects.toThrow("read after receipt failed");
  expect(saved).toEqual(["receipt"]);
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(before + 1);
});
