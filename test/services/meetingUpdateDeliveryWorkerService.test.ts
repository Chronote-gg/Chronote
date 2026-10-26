/** @jest-environment node */
import {
  workerFixture,
  deferred,
  now,
} from "./meetingUpdateDeliveryWorker.fixture";
import { verifyMeetingUpdateDeliveryReadiness } from "../../src/services/meetingUpdateDeliveryWorkerService";
import {
  planDelivery,
  patchOperation,
  submittedState,
} from "../types/meetingUpdateDelivery.fixture";

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now * 1000);
});
afterEach(() => jest.useRealTimers());

test("one immediate poll, five second cadence and no overlapping discovery", async () => {
  const f = workerFixture(),
    entered = deferred<void>(),
    tail = deferred<{ keys: typeof f.keys }>();
  f.repository.listDue.mockImplementation(async () => {
    entered.resolve();
    return tail.promise;
  });
  f.worker.start();
  f.worker.start();
  await entered.promise;
  await jest.advanceTimersByTimeAsync(5000);
  expect(f.repository.listDue).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stop = f.worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  tail.resolve({ keys: [] });
  await stop;
  await jest.advanceTimersByTimeAsync(20000);
  expect(f.repository.listDue).toHaveBeenCalledTimes(1);
  await f.clean();
});
test("each poll visits only 25 candidates, preserves cursor and restarts from the beginning", async () => {
  const f = workerFixture(40);
  await f.worker.poll();
  expect(f.repository.getStrong).toHaveBeenCalledTimes(25);
  expect(f.deliver).toHaveBeenCalledTimes(25);
  await f.worker.poll();
  expect(f.deliver).toHaveBeenCalledTimes(40);
  await f.worker.poll();
  expect(f.repository.listDue.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
  await f.clean();
});
test("stale, held, future and missing GSI discoveries still consume the visit budget", async () => {
  const f = workerFixture(30);
  f.rows[0].updateDelivery.policy = { kind: "held", reason: "stored_only" };
  f.rows[1].updateDelivery.progress = {
    kind: "pending",
    nextCheckAt: now + 60,
  };
  const read = f.repository.getStrong.getMockImplementation()!;
  f.repository.getStrong.mockImplementation(async (key) =>
    key.channelId_timestamp === f.keys[2].channelId_timestamp
      ? undefined
      : read(key),
  );
  await f.worker.poll();
  expect(f.repository.getStrong).toHaveBeenCalledTimes(25);
  expect(f.deliver).toHaveBeenCalledTimes(22);
  await f.clean();
});
test("only two meetings progress while a provider outlives the ten second admission budget", async () => {
  const f = workerFixture(5),
    entered = deferred<void>(),
    tail = deferred<void>();
  let active = 0,
    maximum = 0;
  f.deliver.mockImplementation(async (input) => {
    const claim = f.claimed(input);
    active++;
    maximum = Math.max(maximum, active);
    if (active === 2) entered.resolve();
    await input.work.trackEffect(() => tail.promise);
    active--;
    return {
      kind: "settled",
      capturedRevision: 1,
      durable: { deliveryRevision: "verified", claim },
    };
  });
  const poll = f.worker.poll();
  await entered.promise;
  expect(f.deliver).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(10000);
  await poll;
  expect(maximum).toBe(2);
  expect(f.deliver).toHaveBeenCalledTimes(2);
  expect(
    f.works
      .filter((w) => f.checkpoint(w)?.claim)
      .every((w) => !w.signal.aborted),
  ).toBe(true);
  let stopped = false;
  const stop = f.worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(f.works.filter((w) => f.checkpoint(w)?.claim)).toHaveLength(2);
  tail.resolve();
  await stop;
  expect(f.works.every((w) => !f.checkpoint(w))).toBe(true);
  await f.clean();
});
test("partial pages survive capacity exhaustion and admission clock exhaustion", async () => {
  const f = workerFixture(6),
    tail = deferred<void>(),
    entered = deferred<void>();
  f.deliver.mockImplementationOnce(async () => {
    entered.resolve();
    await tail.promise;
    return {
      kind: "settled",
      capturedRevision: null,
      noClaim: { kind: "never_admitted" },
    };
  });
  const read = f.repository.getStrong.getMockImplementation()!;
  f.repository.getStrong.mockImplementation(async (key) => {
    const row = await read(key);
    jest.setSystemTime(Date.now() + 6000);
    return row;
  });
  await f.worker.poll();
  expect(f.repository.getStrong).toHaveBeenCalledTimes(2);
  tail.resolve();
  await Promise.resolve();
  await f.worker.poll();
  expect(f.repository.getStrong).toHaveBeenCalledTimes(4);
  expect(
    f.repository.getStrong.mock.calls.map(([key]) => key.channelId_timestamp),
  ).toEqual(
    [f.keys[0], f.keys[1], f.keys[1], f.keys[2]].map(
      (k) => k.channelId_timestamp,
    ),
  );
  await entered.promise;
  await f.clean();
});
test("retained attempts dispatch reconciliation without adding a second local owner", async () => {
  const f = workerFixture(),
    tail = deferred<void>();
  f.rows[0].updateDelivery = planDelivery(
    [patchOperation("patch")],
    [submittedState],
  );
  if (!("nextCheckAt" in f.rows[0].updateDelivery.progress))
    throw Error("Expected runnable attempt");
  f.rows[0].updateDelivery.progress = {
    ...f.rows[0].updateDelivery.progress,
    nextCheckAt: now,
  };
  f.reconcile.mockImplementation(async () => {
    await tail.promise;
    return { kind: "uncertain", capturedRevision: 1 };
  });
  const poll = f.worker.poll();
  await jest.advanceTimersByTimeAsync(0);
  await poll;
  await f.worker.poll();
  expect(f.reconcile).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();
  tail.resolve();
  await f.clean();
});
test("serving denial and unknown acknowledgment cannot release or replay unresolved work", async () => {
  const f = workerFixture();
  f.begin.mockImplementationOnce(() => {
    throw Error("not serving");
  });
  await f.worker.poll();
  expect(f.deliver).not.toHaveBeenCalled();
  f.deliver.mockResolvedValue({ kind: "uncertain", capturedRevision: 1 });
  await f.worker.poll();
  const current = f.works.find(
    (w) => f.checkpoint(w)?.claim === undefined && f.checkpoint(w),
  );
  expect(current?.signal.aborted).toBe(true);
  await f.worker.poll();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  await f.clean();
});
test.each([undefined, "CREATING", "DELETING"])(
  "readiness rejects unavailable index status %s",
  async (status) => {
    await expect(
      verifyMeetingUpdateDeliveryReadiness(async () => status),
    ).rejects.toThrow("ACTIVE");
  },
);
test("readiness accepts only an explicitly ACTIVE configured index", async () => {
  await expect(
    verifyMeetingUpdateDeliveryReadiness(async () => "ACTIVE"),
  ).resolves.toBeUndefined();
});

test("authority refresh exhausting the poll budget admits no later discovery", async () => {
  const f = workerFixture();
  const begin = f.begin.getMockImplementation()!;
  f.begin.mockImplementation((...args) => {
    const work = begin(...args);
    work.authority = async () => {
      jest.setSystemTime((now + 11) * 1000);
      return {
        kind: "serving",
        context: {
          instanceId: "old",
          now,
          identity: {
            kind: "ecs",
            instanceId: "old",
            taskArn: "synthetic",
            imageDigest: "synthetic",
            candidateId: "synthetic",
            protocolVersion: 1,
          },
          authorizedGeneration: 7,
          observedEpoch: 3,
          protocolVersion: 1,
        },
      };
    };
    return work;
  });
  await f.worker.poll();
  expect(f.repository.listDue).not.toHaveBeenCalled();
  await f.clean();
});

test("a Query finishing after the deadline retains its first key and cursor for the next poll", async () => {
  const f = workerFixture(4),
    entered = deferred<void>();
  const tail = deferred<{ keys: typeof f.keys; cursor: string }>();
  f.repository.listDue.mockImplementationOnce(async () => {
    entered.resolve();
    return tail.promise;
  });
  const first = f.worker.poll();
  await entered.promise;
  jest.setSystemTime((now + 11) * 1000);
  tail.resolve({ keys: f.keys.slice(0, 2), cursor: "2" });
  await first;
  expect(f.repository.getStrong).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(f.repository.listDue).toHaveBeenCalledTimes(1);
  await f.worker.poll();
  expect(f.repository.getStrong.mock.calls.map(([key]) => key)).toEqual(f.keys);
  expect(f.deliver.mock.calls.map(([input]) => input.key)).toEqual(f.keys);
  expect(f.repository.listDue).toHaveBeenCalledTimes(2);
  expect(f.repository.listDue.mock.calls[1][0].cursor).toBe("2");
  await f.clean();
});
