/** @jest-environment node */
import * as repository from "../../src/repositories/renewalRecoveryRepository";
import * as reconciliation from "../../src/services/subscriptionReconciliation";
import { runRenewalRecoveryPoll } from "../../src/services/renewalRecoveryWorkerService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import {
  renewalRecoveryKey,
  type RenewalRecovery,
} from "../../src/types/renewalRecovery";
import { renewalProviderFixture } from "../fixtures/renewalRecoveryProviderStripe";
import { renewalSubscription } from "../fixtures/renewal";
import type { StripeTransportRequest } from "../fixtures/stripeTransport";

const original = {
  mock: config.mock.enabled,
  mode: config.subscription.stripeMode,
};
beforeEach(() => {
  config.mock.enabled = true;
  config.subscription.stripeMode = "test";
  resetMockStore();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  config.mock.enabled = original.mock;
  config.subscription.stripeMode = original.mode;
});

/** A due cancellation in the mock store, reconciled against the provider fake that honours idempotency keys. */
function dueCancellation(
  beforeWrite?: (request: StripeTransportRequest) => Promise<void>,
  recordWrites: {
    before?: (next: RenewalRecovery) => Promise<void>;
    after?: (next: RenewalRecovery) => void;
  } = {},
) {
  const provider = renewalProviderFixture(0, 0, 0, 0, {
    honorIdempotencyKeys: true,
    beforeWrite,
  });
  const record = provider.recovery;
  const key = renewalRecoveryKey(record);
  const store = getMockStore();
  store.subscriptions.set(record.guildId, {
    ...renewalSubscription,
    guildId: record.guildId,
    stripeCustomerId: record.customerId,
    status: "past_due",
  });
  store.renewalRecoveryRecords.set(key, record);
  store.renewalRecoveryPointers.set(record.guildId, {
    key,
    revision: record.revision,
    blocking: true,
  });
  // The subscription projection after the provider cancels; its own tests cover it.
  jest
    .spyOn(reconciliation, "reconcileSubscription")
    .mockImplementation(async (_stripe, guildId) => {
      const saved = store.subscriptions.get(guildId);
      if (saved)
        store.subscriptions.set(guildId, { ...saved, status: "canceled" });
    });
  const actual = repository.getRenewalRecoveryRepository();
  const writes: boolean[] = [];
  jest.spyOn(repository, "getRenewalRecoveryRepository").mockReturnValue({
    ...actual,
    async compareAndWrite(input) {
      await recordWrites.before?.(input.next);
      const written = await actual.compareAndWrite(input);
      writes.push(written);
      recordWrites.after?.(input.next);
      return written;
    },
  });
  const poll = () =>
    runRenewalRecoveryPoll({
      stripe: provider.stripe,
      now: "nextCheckAt" in record ? record.nextCheckAt : 0,
      signal: new AbortController().signal,
    });
  const current = () => repository.getRenewalRecoveryRepository().get(key);
  return { provider, writes, poll, current };
}
const mutating = (requests: StripeTransportRequest[]) =>
  requests.filter((request) => request.method !== "GET");
const withoutRevision = (record: RenewalRecovery | undefined) => {
  if (!record) return record;
  const { revision, ...rest } = record;
  void revision;
  return rest;
};

test("two overlapping renewal recovery polls are deduplicated by the idempotency key and the revision check", async () => {
  const single = dueCancellation();
  await single.poll();
  const singleRecord = await single.current();
  const singleKeys = mutating(single.provider.requests).map(
    (request) => request.idempotencyKey,
  );
  resetMockStore();
  jest.restoreAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);

  let firstWriteHeld!: () => void;
  const firstHeld = new Promise<void>((done) => {
    firstWriteHeld = done;
  });
  let secondWriteArrived!: () => void;
  const secondArrived = new Promise<void>((done) => {
    secondWriteArrived = done;
  });
  let writesSeen = 0;
  const overlapping = dueCancellation(async () => {
    writesSeen += 1;
    if (writesSeen === 1) {
      firstWriteHeld();
      await secondArrived;
    } else if (writesSeen === 2) secondWriteArrived();
  });
  const first = overlapping.poll();
  await firstHeld;
  const second = overlapping.poll();
  await expect(Promise.all([first, second])).resolves.toEqual([
    undefined,
    undefined,
  ]);

  const requests = mutating(overlapping.provider.requests);
  expect(requests.every((request) => request.idempotencyKey)).toBe(true);
  const [held, overlap] = requests;
  expect(overlap.path).toBe(held.path);
  expect(overlap.idempotencyKey).toBe(held.idempotencyKey);
  expect(new Set(requests.map((request) => request.idempotencyKey))).toEqual(
    new Set(singleKeys),
  );
  expect(overlapping.provider.notes).toHaveLength(1);
  expect(overlapping.writes.filter((written) => !written)).toHaveLength(1);
  expect(overlapping.writes.filter((written) => written)).toHaveLength(
    single.writes.length,
  );
  expect(withoutRevision(await overlapping.current())).toEqual(
    withoutRevision(singleRecord),
  );
  expect(singleRecord?.state).toBe("canceled");
});
