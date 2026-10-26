/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import {
  deliveryFixture,
  loseAcknowledgement,
  hasSubmission,
  deferred,
} from "./meetingUpdateDelivery.fixture";
import {
  initializeDeliveryClock,
  settleDeliveryWorks,
  runDelivery,
  getRuntimeWorkAdmissionCheckpoints,
} from "./meetingUpdateDelivery.harness";
import { now } from "../types/meetingUpdateDelivery.fixture";
beforeEach(initializeDeliveryClock);
afterEach(settleDeliveryWorks);
test.each([429, 500, "network"] as const)(
  "retains accepted DELETE across a %s verification failure and verifies once after reclaim",
  async (status) => {
    const f = deliveryFixture("x".repeat(9000), "Short");
    const deleted = f.input.history.notesMessageIds[1];
    let failed = false;
    f.intercept(async (method, id) => {
      if (method === "GET" && id === deleted && !f.remote.has(id) && !failed) {
        failed = true;
        if (status === "network")
          throw new Error("Synthetic verification network failure");
        return Response.json({ retry_after: 120 }, { status });
      }
      return undefined;
    });
    await runDelivery(f).promise;
    const before = await f.read();
    expect(before.updateDelivery.progress.kind).toBe("reconciling");
    if (!("attempt" in before.updateDelivery.progress))
      throw new Error("Expected retained accepted attempt");
    const retained = before.updateDelivery.progress;
    expect(retained.operations.at(-1)?.submission).toMatchObject({
      kind: "uncertain",
      reason: "completion_unknown",
    });
    expect(before.updateDelivery.attempts).toBe(0);
    expect(before.updateDelivery.parts.notesBody.acknowledged).toBe(0);
    if (!("nextCheckAt" in retained))
      throw new Error("Expected scheduled reconciliation");
    expect(retained.nextCheckAt).toBeGreaterThanOrEqual(
      now + (status === 429 ? 120 : 60),
    );
    const reads = f.calls.length;
    await runDelivery(f).promise;
    expect(f.calls).toHaveLength(reads);
    jest.mocked(Date.now).mockReturnValue((retained.nextCheckAt + 1) * 1000);
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const after = await f.read();
    expect(after.updateDelivery.parts.notesBody.acknowledged).toBe(1);
    expect(after.updateDelivery.cleanupCandidates).toEqual([]);
    expect(
      f.calls.filter((call) => call.method === "DELETE" && call.id === deleted),
    ).toHaveLength(1);
  },
);
test.each(["PATCH", "POST"] as const)(
  "retains accepted %s and provider Retry-After without replay",
  async (method) => {
    const f = deliveryFixture(
      "Old",
      method === "POST" ? "x".repeat(9000) : "Edited",
    );
    let target: string | undefined;
    let failed = false;
    f.intercept(async (request, id) => {
      if (request === "GET" && !failed) {
        const accepted = f.requests.find((entry) => entry.method === method);
        const candidate =
          method === "POST"
            ? [...f.remote.keys()].find(
                (key) =>
                  !f.input.messages.some((message) => message.id === key),
              )
            : accepted?.id;
        if (accepted && id === candidate) {
          target = id;
          failed = true;
          return Response.json({ retry_after: 120 }, { status: 429 });
        }
      }
      return undefined;
    });
    await runDelivery(f).promise;
    const row = await f.read();
    expect(row.updateDelivery.progress.kind).toBe("reconciling");
    if (!("nextCheckAt" in row.updateDelivery.progress))
      throw new Error("Missing due");
    expect(row.updateDelivery.progress.nextCheckAt).toBeGreaterThanOrEqual(
      now + 120,
    );
    expect(row.updateDelivery.attempts).toBe(0);
    expect(target).toBeDefined();
    jest
      .mocked(Date.now)
      .mockReturnValue((row.updateDelivery.progress.nextCheckAt + 1) * 1000);
    await runDelivery(f).promise;
    expect(f.requests.filter((entry) => entry.method === method)).toHaveLength(
      1,
    );
    if (method === "PATCH")
      expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(
        1,
      );
    else
      expect(
        (await f.read()).updateDelivery.createdCandidates[0]?.messageId,
      ).toBe(target);
  },
);
test("acceptance marker lost ACK requires exact durable readback", async () => {
  const f = deliveryFixture();
  let accepted = 0;
  loseAcknowledgement(f.repository, "transition", (input) => {
    if (hasSubmission(input, "uncertain")) {
      accepted++;
      return true;
    }
    return false;
  });
  expect((await runDelivery(f).promise).kind).toBe("settled");
  expect(f.requests.filter((entry) => entry.method === "PATCH")).toHaveLength(
    1,
  );
  expect(accepted).toBe(1);
});
test("accepted verification failures do not spend a seven-failure budget", async () => {
  const f = deliveryFixture();
  f.setRow({
    ...f.input.history,
    updateDelivery: { ...f.input.history.updateDelivery, attempts: 7 },
  });
  f.intercept(async (method) =>
    method === "GET" && f.requests.length
      ? Response.json({}, { status: 500 })
      : undefined,
  );
  await runDelivery(f).promise;
  expect((await f.read()).updateDelivery.attempts).toBe(7);
  expect((await f.read()).updateDelivery.progress.kind).toBe("reconciling");
  for (let retry = 0; retry < 2; retry++) {
    const progress = (await f.read()).updateDelivery.progress;
    if (!("nextCheckAt" in progress)) throw new Error("Missing retry due");
    jest.mocked(Date.now).mockReturnValue((progress.nextCheckAt + 1) * 1000);
    await runDelivery(f).promise;
    expect((await f.read()).updateDelivery.attempts).toBe(7);
  }
  f.intercept(undefined);
  const progress = (await f.read()).updateDelivery.progress;
  if (!("nextCheckAt" in progress)) throw new Error("Missing retry due");
  jest.mocked(Date.now).mockReturnValue((progress.nextCheckAt + 1) * 1000);
  expect((await runDelivery(f).promise).kind).toBe("settled");
  expect((await f.read()).updateDelivery.attempts).toBe(0);
});

test("uncommitted accepted marker cannot authorize completion from matching GET", async () => {
  const f = deliveryFixture();
  const transition = f.repository.transition.bind(f.repository);
  jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
    if (
      input.change.kind === "progress" &&
      "operations" in input.change.progress &&
      input.change.progress.operations.some(
        (op) =>
          op.submission.kind === "uncertain" &&
          op.submission.reason === "completion_unknown",
      )
    )
      return "stale";
    return transition(input);
  });
  await runDelivery(f).promise;
  expect((await f.read()).updateDelivery.progress.kind).toBe("uncertain");
  jest.mocked(Date.now).mockReturnValue((now + 120) * 1000);
  await runDelivery(f, true).promise;
  expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(0);
  expect(
    f.requests.filter((request) => request.method === "PATCH"),
  ).toHaveLength(1);
});

test("queued renewal preserves accepted verification delay after stopRenewals", async () => {
  const timers = jest.spyOn(global, "setTimeout");
  const clearTimer = global.clearTimeout;
  const events: string[] = [];
  const holdEntered = deferred<void>();
  const releaseHold = deferred<void>();
  const renewalEntered = deferred<void>();
  const releaseRenewal = deferred<void>();
  const stopped = deferred<void>();
  let renewalTimer: unknown;
  const cleared = jest
    .spyOn(global, "clearTimeout")
    .mockImplementation((timer) => {
      clearTimer(timer);
      if (timer === renewalTimer) {
        events.push("stopped");
        stopped.resolve();
      }
    });
  try {
    const f = deliveryFixture();
    let verificationFailed = false;
    f.intercept(async (method, id) => {
      if (
        method === "GET" &&
        !verificationFailed &&
        f.requests.some(
          (request) => request.method === "PATCH" && request.id === id,
        )
      ) {
        verificationFailed = true;
        return Response.json({ retry_after: 120 }, { status: 429 });
      }
      return undefined;
    });
    const transition = f.repository.transition.bind(f.repository);
    jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
      const reconciling =
        input.change.kind === "progress" &&
        input.change.progress.kind === "reconciling"
          ? input.change.progress
          : null;
      if (reconciling && reconciling.claim.leaseExpiresAt > now + 60) {
        events.push("renewal entered");
        renewalEntered.resolve();
        await stopped.promise;
        await releaseRenewal.promise;
        const result = await transition(input);
        expect(result).toBe("applied");
        events.push("renewal committed");
        return result;
      }
      const result = await transition(input);
      if (reconciling && reconciling.claim.leaseExpiresAt === now + 60) {
        expect(result).toBe("applied");
        events.push("hold committed");
        holdEntered.resolve();
        await releaseHold.promise;
      }
      return result;
    });
    const invocation = runDelivery(f);
    await Promise.race([
      holdEntered.promise,
      invocation.promise.then(() => {
        throw new Error("Delivery ended before the hold barrier");
      }),
    ]);
    const timerIndex = timers.mock.calls.findIndex(
      ([, delay]) => delay === 20000,
    );
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    renewalTimer = timers.mock.results[timerIndex].value;
    const held = await f.read();
    expect(held.updateDelivery.progress).toMatchObject({
      kind: "reconciling",
      nextCheckAt: now + 120,
    });
    jest.mocked(Date.now).mockReturnValue((now + 20) * 1000);
    events.push("renewal queued");
    const [renewalCallback] = timers.mock.calls[timerIndex];
    renewalCallback();
    expect(events).toEqual(["hold committed", "renewal queued"]);
    releaseHold.resolve();
    await Promise.all([renewalEntered.promise, stopped.promise]);
    expect(events.at(-1)).not.toBe("renewal committed");
    releaseRenewal.resolve();
    const result = await invocation.promise;
    expect(events.indexOf("renewal committed")).toBeGreaterThan(
      events.indexOf("stopped"),
    );
    expect(events.indexOf("renewal entered")).toBeGreaterThan(
      events.indexOf("renewal queued"),
    );
    const retained = await f.read();
    expect(retained.updateDelivery.progress).toMatchObject({
      kind: "reconciling",
      claim: { leaseExpiresAt: now + 80 },
      operations: [
        { submission: { kind: "uncertain", reason: "completion_unknown" } },
      ],
    });
    expect(retained.updateDelivery.attempts).toBe(0);
    expect(retained.updateDelivery.parts.notesBody.acknowledged).toBe(0);
    expect(result.durable?.claim?.expiresAt).toBe(now + 80);
    expect(
      getRuntimeWorkAdmissionCheckpoints().find(
        (item) => item.signal === invocation.work.signal,
      )?.claim?.expiresAt,
    ).toBe(now + 80);
    if (retained.updateDelivery.progress.kind !== "reconciling")
      throw new Error("Expected accepted reconciliation");
    expect(retained.updateDelivery.progress.nextCheckAt).toBeGreaterThanOrEqual(
      now + 120,
    );
    expect(retained.updateDeliveryDueAt).toBeGreaterThanOrEqual(now + 120);
    const calls = f.calls.length;
    jest.mocked(Date.now).mockReturnValue((now + 81) * 1000);
    await runDelivery(f).promise;
    expect(f.calls).toHaveLength(calls);
    jest.mocked(Date.now).mockReturnValue((now + 121) * 1000);
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const completed = await f.read();
    expect(completed.updateDelivery.parts.notesBody.acknowledged).toBe(1);
    expect(completed.updateDelivery.attempts).toBe(0);
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  } finally {
    releaseHold.resolve();
    releaseRenewal.resolve();
    cleared.mockRestore();
    timers.mockRestore();
  }
});
