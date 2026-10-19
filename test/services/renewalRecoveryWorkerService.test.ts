/** @jest-environment node */
import {
  verifyRenewalRecoveryReadiness,
  startRenewalRecoveryWorker,
  stopRenewalRecoveryWorker,
  runRenewalRecoveryPoll,
} from "../../src/services/renewalRecoveryWorkerService";
import { reconcileBillingChangeForWebhook } from "../../src/services/billingChangeService";
import { pendingFundingChange } from "../fixtures/pendingFundingChange";
import { response } from "../fixtures/renewalStripeClient";
import * as recovery from "../../src/services/renewalRecoveryService";
import * as repository from "../../src/repositories/renewalRecoveryRepository";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import {
  renewalRecoveryKey,
  renewalRecoverySchema,
} from "../../src/types/renewalRecovery";
import { stripeTransport } from "../fixtures/stripeTransport";
import { context, control, runtime } from "../deployment/controlFixtures";
import { getRuntimeAdmissionContext } from "../../src/services/runtimeLifecycleService";
import {
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
  getRuntimeAdmissionContext: jest.fn(async () => context),
}));
const stripe = stripeTransport(() => {
  throw new Error("Unexpected provider request");
}).stripe;
const original = {
  mock: config.mock.enabled,
  mode: config.subscription.stripeMode,
};
function seed(index = 0) {
  const guildId = String(999999999999999900n + BigInt(index));
  const record = renewalRecoverySchema.parse({
    guildId,
    subscriptionId: `sub_${index}`,
    customerId: "cus_owned",
    payerId: "payer",
    mode: "test",
    revision: "r1",
    paid: {
      invoiceId: "in_paid",
      priceId: "price_basic",
      tier: "basic",
      interval: "month",
      periodStart: 1,
      periodEnd: 100,
    },
    scheduledOperationId: null,
    enforcementAccepted: false,
    state: "watching",
    nextCheckAt: 100,
  });
  const key = renewalRecoveryKey(record);
  getMockStore().renewalRecoveryRecords.set(key, record);
  getMockStore().renewalRecoveryPointers.set(guildId, {
    key,
    revision: record.revision,
    blocking: false,
  });
  return record;
}
beforeEach(() => {
  config.mock.enabled = true;
  config.subscription.stripeMode = "test";
  resetMockStore();
  for (const record of [control, runtime("old")])
    getMockStore().deploymentControlRecords.set(
      JSON.stringify([record.pk, record.sk]),
      structuredClone(record),
    );
  jest.spyOn(recovery, "reconcileRenewalRecovery").mockResolvedValue();
  jest.mocked(getRuntimeAdmissionContext).mockResolvedValue(context);
});
afterEach(async () => {
  await stopRenewalRecoveryWorker();
  jest.useRealTimers();
  jest.restoreAllMocks();
  config.mock.enabled = original.mock;
  config.subscription.stripeMode = original.mode;
});
test("polls immediately and at a fixed minute interval", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(200000);
  seed();
  startRenewalRecoveryWorker(stripe);
  await jest.advanceTimersByTimeAsync(0);
  expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(59999);
  expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(2);
});
test("traverses due pages and isolates a failed recovery from the next page", async () => {
  const first = seed();
  const second = seed(1);
  const actual = repository.getRenewalRecoveryRepository();
  const listDue = jest
    .fn()
    .mockResolvedValueOnce({
      keys: [renewalRecoveryKey(first)],
      cursor: "next",
    })
    .mockResolvedValueOnce({ keys: [renewalRecoveryKey(second)] });
  jest
    .spyOn(repository, "getRenewalRecoveryRepository")
    .mockReturnValue({ ...actual, listDue });
  jest
    .mocked(recovery.reconcileRenewalRecovery)
    .mockRejectedValueOnce(new Error("Provider unavailable"));
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  await runRenewalRecoveryPoll({
    stripe,
    now: 200,
    signal: new AbortController().signal,
  });
  expect(listDue).toHaveBeenCalledTimes(2);
  expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(2);
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(0);
});
test("denied admission performs no provider work", async () => {
  seed();
  jest
    .mocked(getRuntimeAdmissionContext)
    .mockRejectedValue(new Error("Runtime retiring"));
  await expect(
    runRenewalRecoveryPoll({
      stripe,
      now: 200,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Runtime retiring");
  expect(recovery.reconcileRenewalRecovery).not.toHaveBeenCalled();
});
test("two polls cannot process one locally owned cycle concurrently", async () => {
  seed();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((done) => {
    entered = done;
  });
  jest
    .mocked(recovery.reconcileRenewalRecovery)
    .mockImplementation(async () => {
      entered();
      await new Promise<void>((done) => {
        release = done;
      });
    });
  const first = runRenewalRecoveryPoll({
    stripe,
    now: 200,
    signal: new AbortController().signal,
  });
  await enteredPromise;
  await runRenewalRecoveryPoll({
    stripe,
    now: 200,
    signal: new AbortController().signal,
  });
  expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(1);
  release();
  await first;
});
test.each([true, false])(
  "worker stop refuses nested effects with runtime fence=%s",
  async (fenceRuntime) => {
    jest.useFakeTimers();
    jest.setSystemTime(200000);
    const record = seed();
    const { client, operation } = pendingFundingChange(record.guildId);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((done) => {
      entered = done;
    });
    const nextWrite = jest
      .spyOn(client.stripe.invoices, "create")
      .mockRejectedValue(new Error("Unexpected new invoice"));
    client.retrieve.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((done) => {
        release = done;
      });
      return response(client.provider);
    });
    jest
      .mocked(recovery.reconcileRenewalRecovery)
      .mockImplementation(async (input) => {
        await input.stripe.subscriptions.retrieve(
          operation.source.subscriptionId,
        );
        await reconcileBillingChangeForWebhook(
          input.stripe,
          record.guildId,
          operation.createdAt,
          input.owner,
        );
      });
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    startRenewalRecoveryWorker(client.stripe);
    await enteredPromise;
    let stopped = false;
    const stopping = stopRenewalRecoveryWorker().then(() => {
      stopped = true;
    });
    if (fenceRuntime) fenceRuntimeWorkAdmissions();
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(nextWrite).not.toHaveBeenCalled();
    expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(0);
  },
);
test("stale index keys are harmless and do not reconcile another current cycle", async () => {
  const record = seed();
  const actual = repository.getRenewalRecoveryRepository();
  jest.spyOn(repository, "getRenewalRecoveryRepository").mockReturnValue({
    ...actual,
    listDue: jest.fn(async () => ({
      keys: ["missing", renewalRecoveryKey(record)],
    })),
    get: jest.fn(async () => undefined),
  });
  await runRenewalRecoveryPoll({
    stripe,
    now: 200,
    signal: new AbortController().signal,
  });
  expect(recovery.reconcileRenewalRecovery).not.toHaveBeenCalled();
});

test("enforcement readiness verifies provider mode and usable due index before startup", async () => {
  const enabled = config.stripe.renewalGraceEnabled;
  config.stripe.renewalGraceEnabled = true;
  const f = stripeTransport(({ path }) => {
    if (path === "/v1/balance") return { livemode: false };
    throw new Error(`Unexpected ${path}`);
  });
  try {
    await expect(
      verifyRenewalRecoveryReadiness(f.stripe),
    ).resolves.toBeUndefined();
    config.subscription.stripeMode = "live";
    await expect(verifyRenewalRecoveryReadiness(f.stripe)).rejects.toThrow(
      "mode mismatch",
    );
    config.subscription.stripeMode = "test";
    const actual = repository.getRenewalRecoveryRepository();
    jest.spyOn(repository, "getRenewalRecoveryRepository").mockReturnValue({
      ...actual,
      listDue: jest.fn(async () => {
        throw new Error("Index is not ACTIVE");
      }),
    });
    await expect(verifyRenewalRecoveryReadiness(f.stripe)).rejects.toThrow(
      "Index is not ACTIVE",
    );
  } finally {
    config.stripe.renewalGraceEnabled = enabled;
  }
});

test("maintenance refusal preserves due recovery and prevents its active lifetime", async () => {
  seed();
  const db = await import("../../src/db");
  jest.spyOn(db, "getDeploymentControlRepository").mockReturnValue({
    ...db.getDeploymentControlRepository(),
    checkAdmission: jest.fn(async () => ({
      kind: "blocked" as const,
      reason: "not_serving" as const,
    })),
  });
  await runRenewalRecoveryPoll({
    stripe,
    now: 200,
    signal: new AbortController().signal,
  });
  expect(recovery.reconcileRenewalRecovery).not.toHaveBeenCalled();
});
