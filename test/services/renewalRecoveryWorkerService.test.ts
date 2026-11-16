/** @jest-environment node */
// These suites exercise the pollers themselves; eligibility gating has its own suite.
jest.mock("../../src/services/workerRegistry", () => ({
  isEligible: () => true,
}));
import {
  verifyRenewalRecoveryReadiness,
  startRenewalRecoveryWorker,
  stopRenewalRecoveryWorker,
  runRenewalRecoveryPoll,
  releaseRenewalRecoveryLease,
} from "../../src/services/renewalRecoveryWorkerService";
import { RENEWAL_RECOVERY_STALLED_LOG } from "../../src/metrics";
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
import { UnresolvedBillingMutation } from "../../src/services/runtimeBillingOperationService";
import * as jobLeases from "../../src/repositories/jobLeaseRepository";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
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
  jest.spyOn(recovery, "reconcileRenewalRecovery").mockResolvedValue();
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
});
test("a poll runs without any deployment control record", async () => {
  seed();
  await runRenewalRecoveryPoll({
    stripe,
    now: 200,
    signal: new AbortController().signal,
  });
  expect(getMockStore().deploymentControlRecords.size).toBe(0);
  expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(1);
});
test("worker start runs one poll at a time", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(200000);
  seed();
  let release!: () => void;
  jest
    .mocked(recovery.reconcileRenewalRecovery)
    .mockImplementation(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
    });
  startRenewalRecoveryWorker(stripe);
  await jest.advanceTimersByTimeAsync(60000);
  expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(1);
  release();
  await jest.advanceTimersByTimeAsync(0);
});
test("worker stop refuses nested effects", async () => {
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
        input.effect,
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
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(nextWrite).not.toHaveBeenCalled();
});
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

test.each(["read failure", "domain ACK then failure", "domain ACK lost"])(
  "worker %s preserves actual mutation knowledge",
  async (stage) => {
    seed(
      ["read failure", "domain ACK then failure", "domain ACK lost"].indexOf(
        stage,
      ) + 10,
    );
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    jest
      .mocked(recovery.reconcileRenewalRecovery)
      .mockImplementationOnce(async (input) => {
        if (stage !== "read failure")
          await input.owner!.effect(async () => {
            if (stage === "domain ACK lost")
              throw new Error("domain response lost");
          });
        throw new Error("provider read unavailable");
      });
    await runRenewalRecoveryPoll({
      stripe,
      now: 200,
      signal: new AbortController().signal,
    });
    const [, { error }] = warn.mock.calls[0];
    expect(error instanceof UnresolvedBillingMutation).toBe(
      stage !== "read failure",
    );
  },
);

describe("renewal recovery job lease", () => {
  const poll = () =>
    runRenewalRecoveryPoll({
      stripe,
      now: 200,
      signal: new AbortController().signal,
    });
  const otherWorkerHolds = () =>
    jobLeases.getJobLeaseRepository().tryAcquireJobLease({
      name: "renewal-recovery",
      owner: "synthetic-other-worker",
      now: Math.floor(Date.now() / 1000),
      ttlSeconds: LIFECYCLE.renewalRecoveryLeaseSeconds,
    });
  test("a poll is skipped when another worker holds the lease", async () => {
    seed();
    const provider = jest.fn(() => {
      throw new Error("Unexpected provider request");
    });
    const transport = stripeTransport(provider);
    await expect(otherWorkerHolds()).resolves.toBe(true);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const listDue = jest.spyOn(repository, "getRenewalRecoveryRepository");
    await runRenewalRecoveryPoll({
      stripe: transport.stripe,
      now: 200,
      signal: new AbortController().signal,
    });
    expect(listDue).not.toHaveBeenCalled();
    expect(recovery.reconcileRenewalRecovery).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  test("a poll is skipped when the lease check fails", async () => {
    seed();
    jest.spyOn(jobLeases, "getJobLeaseRepository").mockReturnValue({
      tryAcquireJobLease: jest.fn(async () => {
        throw new Error("Lease table unavailable");
      }),
      releaseJobLease: jest.fn(async () => undefined),
    });
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await expect(poll()).resolves.toBeUndefined();
    expect(recovery.reconcileRenewalRecovery).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(RENEWAL_RECOVERY_STALLED_LOG, "Error");
  });
  test("the lease holder polls as before", async () => {
    seed();
    await poll();
    await poll();
    expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(2);
    await expect(otherWorkerHolds()).resolves.toBe(false);
    await expect(
      jobLeases.getJobLeaseRepository().tryAcquireJobLease({
        name: "renewal-recovery",
        owner: getRuntimeInstanceId(),
        now: Math.floor(Date.now() / 1000),
        ttlSeconds: LIFECYCLE.renewalRecoveryLeaseSeconds,
      }),
    ).resolves.toBe(true);
  });
  test("a poll that loses the lease stops before its next due record", async () => {
    const first = seed();
    seed(1);
    let calls = 0;
    const actual = jobLeases.getJobLeaseRepository();
    jest.spyOn(jobLeases, "getJobLeaseRepository").mockReturnValue({
      ...actual,
      async tryAcquireJobLease(input) {
        calls += 1;
        // Poll start and the first record hold it; another worker owns it by the second record.
        return calls <= 2 && actual.tryAcquireJobLease(input);
      },
    });
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    await poll();
    expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledTimes(1);
    expect(recovery.reconcileRenewalRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: first.guildId }),
    );
  });
  test("releasing the lease lets another worker poll at once", async () => {
    seed();
    await poll();
    await expect(otherWorkerHolds()).resolves.toBe(false);
    await releaseRenewalRecoveryLease();
    await expect(otherWorkerHolds()).resolves.toBe(true);
  });
});
