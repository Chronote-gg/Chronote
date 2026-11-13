/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import {
  MINUTE_MS,
  START_MS,
  OLD_ARN,
  PREVIOUS_IMAGE,
  NEW_IMAGE,
  CUTOVER,
  MARKER_READ_ATTEMPTS,
  worker,
  harness,
} from "./deployHarness.fixture.js";

describe("wait-drain: an older task that is still the serving worker", () => {
  const OLD_TASK = {
    taskArn: "task/old",
    taskDefinitionArn: OLD_ARN,
    lastStatus: "RUNNING",
  };
  const freshSeconds = (clock) => Math.floor(clock / 1000);
  const servingHarness = (records, overrides = {}) =>
    harness({
      tasks: [{ ...OLD_TASK }],
      registry: (clock) => [CUTOVER, ...records(freshSeconds(clock))],
      ...overrides,
    });
  const oldRecord = (nowSeconds, fields = {}) =>
    worker("i-old", {
      release: 6,
      taskArn: OLD_TASK.taskArn,
      heartbeatAt: nowSeconds,
      ...fields,
    });
  const stopsAtTenMinutes = (clock, state) => {
    if (clock - START_MS >= 10 * MINUTE_MS) state.tasks = [];
  };

  test.each([false, true])(
    "is neither waited for nor retired (retire %s)",
    async (retire) => {
      const h = servingHarness((now) => [
        oldRecord(now),
        worker("i-failed", { release: 7, ready: false, heartbeatAt: now }),
      ]);
      await expect(h.deploy.waitDrain({ retire })).resolves.toBeUndefined();
      expect(h.elapsed()).toBe(0);
      expect(h.named("ecs.stop-task")).toHaveLength(0);
      expect(h.named("cloudwatch.put-metric-data")).toHaveLength(0);
      expect(
        h.logs.filter((line) =>
          /task\/old is the serving worker.*not waited for/.test(line),
        ),
      ).toHaveLength(1);
    },
  );
  test("is waited for and retired once a newer release is ready", async () => {
    const records = (now) => [
      oldRecord(now),
      worker("i-new", { release: 7, heartbeatAt: now }),
    ];
    const waiting = servingHarness(records, { onSleep: stopsAtTenMinutes });
    await expect(waiting.deploy.waitDrain()).resolves.toBeUndefined();
    expect(waiting.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
    const retiring = servingHarness(records);
    await retiring.deploy.waitDrain({ retire: true });
    expect(retiring.named("ecs.stop-task").map((c) => c.params.task)).toEqual([
      "task/old",
    ]);
  });
  test.each([
    ["stale", (now) => [oldRecord(now, { heartbeatAt: now - 31 })]],
    ["not ready", (now) => [oldRecord(now, { ready: false })]],
    ["missing", () => []],
  ])("is waited for when its record is %s", async (_, records) => {
    const h = servingHarness(records, { onSleep: stopsAtTenMinutes });
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
  });
  test("the rollout proceeds after a drain wait that skipped it", async () => {
    const h = servingHarness((now) => [oldRecord(now)]);
    await h.deploy.waitDrain({ retire: true });
    await expect(h.deploy.rollout({ image: NEW_IMAGE })).resolves.toEqual({
      revision: 8,
      previousImage: PREVIOUS_IMAGE,
    });
    expect(h.named("ecs.stop-task")).toHaveLength(0);
  });
  test("a real drain keeps waiting when the newer record is stale for one poll", async () => {
    const staleAt = START_MS + 30_000;
    const h = servingHarness(
      (now) => [
        oldRecord(now),
        worker("i-new", {
          release: 7,
          heartbeatAt: now * 1000 === staleAt ? now - 31 : now,
        }),
      ],
      { onSleep: stopsAtTenMinutes },
    );
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
    expect(h.logs.some((line) => /not waited for/.test(line))).toBe(false);
  });
  /** Fails registry reads `first` to `first + 2` (one exhausted retry), else `then`. */
  const unreadableFrom = (first, then) => {
    let calls = 0;
    return (clock) => {
      calls += 1;
      if (calls >= first && calls < first + MARKER_READ_ATTEMPTS)
        throw new Error("ProvisionedThroughputExceeded");
      return [CUTOVER, ...then(freshSeconds(clock))];
    };
  };
  test("an unreadable registry during a drain without retire waits and polls again", async () => {
    // Read 1 is the marker, read 2 the first evaluation, reads 3 to 5 the second poll.
    const h = harness({
      tasks: [{ ...OLD_TASK }, { ...OLD_TASK, taskArn: "task/older" }],
      registry: unreadableFrom(3, (now) => [oldRecord(now)]),
      onSleep: stopsAtTenMinutes,
    });
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
    expect(
      h.logs.some((line) =>
        /registry could not be read; every older task counts as draining/.test(
          line,
        ),
      ),
    ).toBe(true);
  });
  test("an unreadable registry at the first evaluation calls nothing serving", async () => {
    const h = servingHarness(() => [], {
      registry: unreadableFrom(2, (now) => [oldRecord(now)]),
      onSleep: stopsAtTenMinutes,
    });
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
    expect(h.logs.some((line) => /not waited for/.test(line))).toBe(false);
  });
  test("an unreadable registry with retire fails the step and stops nothing", async () => {
    const h = servingHarness(() => [], {
      registry: unreadableFrom(2, (now) => [oldRecord(now)]),
    });
    await expect(h.deploy.waitDrain({ retire: true })).rejects.toThrow(
      /ProvisionedThroughputExceeded/,
    );
    expect(h.named("ecs.stop-task")).toHaveLength(0);
  });
  test("a serving task becomes draining once a newer worker is ready", async () => {
    const readyAt = START_MS + 2 * MINUTE_MS;
    const h = servingHarness(
      (now) => [
        oldRecord(now),
        ...(now * 1000 >= readyAt
          ? [worker("i-new", { release: 7, heartbeatAt: now })]
          : []),
      ],
      { tasks: [{ ...OLD_TASK }, { ...OLD_TASK, taskArn: "task/older" }] },
    );
    h.state.onSleep = stopsAtTenMinutes;
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
  });
});
