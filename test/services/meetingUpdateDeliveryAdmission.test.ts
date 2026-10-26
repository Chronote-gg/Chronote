/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import {
  runDelivery as run,
  initializeDeliveryClock,
  settleDeliveryWorks,
} from "./meetingUpdateDelivery.harness";
import {
  deliveryFixture,
  deferred,
  hasSubmission,
  afterTransition,
} from "./meetingUpdateDelivery.fixture";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
beforeEach(initializeDeliveryClock);
afterEach(settleDeliveryWorks);

function trackAcquisition(f: ReturnType<typeof deliveryFixture>) {
  const claim = f.repository.claim.bind(f.repository);
  let acquired = false;
  jest.spyOn(f.repository, "claim").mockImplementation(async (input) => {
    const result = await claim(input);
    acquired = result === "claimed";
    return result;
  });
  return { claim, wasAcquired: () => acquired };
}

test.each([false, true])(
  "claim capture cannot borrow a later owner's checkpoint (retained=%s)",
  async (retained) => {
    const f = deliveryFixture();
    const plan = planMeetingUpdate(f.input);
    if (plan.kind !== "ready") throw new Error("Expected real plan");
    if (retained) {
      await f.repository.claim({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: f.input.history.updateDelivery.revision,
        attempt: plan.attempt,
        authority: f.authority,
      });
      jest.spyOn(Date, "now").mockReturnValue((now + 61) * 1000);
    }
    const { claim: originalClaim, wasAcquired } = trackAcquisition(f);
    const originalRead = f.repository.getStrong.bind(f.repository);
    let takenOver = false;
    jest
      .spyOn(f.repository, "getStrong")
      .mockImplementation(async (...args) => {
        if (wasAcquired() && !takenOver) {
          takenOver = true;
          const row = await originalRead(key);
          if (
            !row?.updateDelivery ||
            !("attempt" in row.updateDelivery.progress)
          )
            throw new Error("Expected acquired attempt");
          const takeoverAt =
            row.updateDelivery.progress.claim.leaseExpiresAt + 1;
          jest.spyOn(Date, "now").mockReturnValue(takeoverAt * 1000);
          expect(
            await originalClaim({
              key,
              expectedContentRevision: 1,
              expectedDeliveryRevision: row.updateDelivery.revision,
              attempt: row.updateDelivery.progress.attempt,
              authority: {
                kind: "serving",
                context: {
                  ...f.authority.context,
                  instanceId: "second-owner",
                  now: takeoverAt,
                },
              },
            }),
          ).toBe("claimed");
        }
        return originalRead(...args);
      });
    const transitions = jest.spyOn(f.repository, "transition");
    const invocation = run(f, retained, 10000, { renewalIntervalMs: 1 });
    const checkpoints = jest.spyOn(invocation.work, "recordClaim");
    const result = await invocation.promise;
    expect(takenOver).toBe(true);
    expect(checkpoints).not.toHaveBeenCalled();
    expect(transitions).not.toHaveBeenCalled();
    expect(result.kind).toBe("uncertain");
    expect(result.durable).toBeUndefined();
    expect(f.requests).toEqual([]);
    const final = await f.read();
    expect(final.updateDelivery.progress).toMatchObject({
      kind: "reconciling",
      claim: { ownerInstanceId: "second-owner" },
    });
  },
);

test.each(["held-policy", "work-fence"] as const)(
  "renewal cannot invoke a write after final admission changes: %s",
  async (stop) => {
    const f = deliveryFixture();
    const providerEntered = deferred<void>(),
      providerTail = deferred<Response>();
    const { wasAcquired } = trackAcquisition(f);
    f.intercept(async (method) => {
      if (method === "GET" && wasAcquired()) {
        providerEntered.resolve();
        return providerTail.promise;
      }
      return undefined;
    });
    const invocation = run(f, false, 10000, { renewalIntervalMs: 25 });
    await providerEntered.promise;
    const originalRead = f.repository.getStrong.bind(f.repository);
    const entered = deferred<void>(),
      tail = deferred<void>();
    let paused = false;
    jest
      .spyOn(f.repository, "getStrong")
      .mockImplementation(async (...args) => {
        const row = await originalRead(...args);
        if (!paused) {
          paused = true;
          entered.resolve();
          await tail.promise;
        }
        return row;
      });
    const transitions = jest.spyOn(f.repository, "transition");
    jest.spyOn(Date, "now").mockReturnValue((now + 20) * 1000);
    await entered.promise;
    if (stop === "work-fence") invocation.work.fence();
    else {
      const row = await originalRead(key);
      if (!row?.updateDelivery || !("attempt" in row.updateDelivery.progress))
        throw new Error("Expected claimed delivery");
      expect(
        await f.repository.transition({
          key,
          expectedDeliveryRevision: row.updateDelivery.revision,
          attemptId: row.updateDelivery.progress.attempt.attemptId,
          ownerInstanceId: row.updateDelivery.progress.claim.ownerInstanceId,
          change: {
            kind: "policy",
            revision: "held-before-renewal",
            policy: { kind: "held", reason: "stored_only" },
            nextCheckAt: now + 20,
          },
        }),
      ).toBe("applied");
    }
    tail.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    providerTail.resolve(Response.json(f.input.messages[0]));
    await invocation.promise;
    const renewals = transitions.mock.calls.filter(
      ([input]) =>
        input.change.kind === "progress" &&
        "claim" in input.change.progress &&
        input.change.progress.claim.leaseExpiresAt > now + 60,
    );
    expect(renewals.length).toBe(0);
    expect(f.requests).toEqual([]);
  },
);

test.each([
  [1, 429, 0],
  [2, 429, 0],
  [1, 503, 0],
  [1, 429, 7],
])(
  "prerequisite read window%s status%s with prior%s failures respects timing and budget",
  async (window, status, failures) => {
    const f = deliveryFixture();
    const before = await f.read();
    before.updateDelivery.attempts = failures;
    f.setRow(before);
    const { wasAcquired } = trackAcquisition(f);
    let reads = 0;
    f.intercept(async (method) => {
      if (method === "GET" && wasAcquired() && ++reads === window)
        return Response.json({ retry_after: 180 }, { status });
      return undefined;
    });
    const transitions = jest.spyOn(f.repository, "transition");
    const result = await run(f).promise;
    const after = await f.read();
    expect(result.kind).toBe(failures === 7 ? "blocked" : "retryable");
    expect(after.updateDelivery.attempts).toBe(failures + 1);
    expect(after.updateDelivery.parts).toEqual(before.updateDelivery.parts);
    expect(after.updateDelivery.createdCandidates).toEqual(
      before.updateDelivery.createdCandidates,
    );
    expect(after.updateDelivery.cleanupCandidates).toEqual(
      before.updateDelivery.cleanupCandidates,
    );
    expect(f.requests).toEqual([]);
    expect(
      transitions.mock.calls.filter(([input]) =>
        hasSubmission(input, "submitted"),
      ).length,
    ).toBe(window - 1);
    if (failures === 7)
      expect(after.updateDelivery.progress).toEqual({
        kind: "blocked",
        reason: "retry_exhausted",
      });
    else
      expect(result).toMatchObject({
        retryAt: now + (status === 429 ? 180 : 5),
      });
  },
);

test.each([1, 2])(
  "a newer canonical save during prerequisite window%s preserves rate timing without charging new work",
  async (window) => {
    const f = deliveryFixture();
    const { wasAcquired } = trackAcquisition(f);
    let reads = 0;
    f.intercept(async (method) => {
      if (method === "GET" && wasAcquired() && ++reads === window) {
        await f.save();
        return Response.json({ retry_after: 180 }, { status: 429 });
      }
      return undefined;
    });
    expect((await run(f).promise).kind).toBe("superseded");
    expect((await f.read()).updateDelivery).toMatchObject({
      attempts: 0,
      parts: { notesBody: { desired: 2, acknowledged: 0 } },
      progress: { kind: "pending", nextCheckAt: now + 180 },
    });
    expect(f.requests).toEqual([]);
  },
);

test.each([0, 7])(
  "an observation-only claimed read failure honors timing and budget after prior%s",
  async (failures) => {
    const f = deliveryFixture("Edited notes", "Edited notes");
    const before = await f.read();
    before.updateDelivery.attempts = failures;
    f.setRow(before);
    const initial = planMeetingUpdate(f.input);
    if (initial.kind !== "ready") throw new Error("Expected real plan");
    for (const target of initial.targets)
      f.remote.set(target.messageId, target.after);
    const { wasAcquired } = trackAcquisition(f);
    f.intercept(async (method) =>
      method === "GET" && wasAcquired()
        ? Response.json({ retry_after: 180 }, { status: 429 })
        : undefined,
    );
    const result = await run(f).promise;
    expect(
      jest.mocked(f.repository.claim).mock.calls[0][0].attempt.operations,
    ).toEqual([]);
    await expectKnownReadFailure(f, result, failures);
    expect(f.requests).toEqual([]);
  },
);

test.each([0, 7])(
  "a final read failure after verified provider operations counts prior%s once",
  async (failures) => {
    const f = deliveryFixture();
    const before = await f.read();
    before.updateDelivery.attempts = failures;
    f.setRow(before);
    let verified = false;
    afterTransition(
      f.repository,
      (input) => hasSubmission(input, "verified"),
      () => {
        verified = true;
      },
    );
    f.intercept(async (method) => {
      if (method === "GET" && verified) {
        verified = false;
        return Response.json({ retry_after: 180 }, { status: 429 });
      }
      return undefined;
    });
    const result = await run(f).promise;
    await expectKnownReadFailure(f, result, failures);
    expect(f.requests.map((request) => request.method)).toEqual(["PATCH"]);
  },
);

async function expectKnownReadFailure(
  f: ReturnType<typeof deliveryFixture>,
  result: Awaited<ReturnType<typeof run>["promise"]>,
  failures: number,
) {
  expect(result).toMatchObject(
    failures === 7
      ? { kind: "blocked", reason: "retry_exhausted" }
      : { kind: "retryable", retryAt: now + 180 },
  );
  expect((await f.read()).updateDelivery).toMatchObject({
    attempts: failures + 1,
    parts: { notesBody: { desired: 1, acknowledged: 0 } },
    progress:
      failures === 7
        ? { kind: "blocked", reason: "retry_exhausted" }
        : { kind: "retrying", reason: "not_submitted" },
  });
}
