/** @jest-environment node */
import { getEventListeners } from "node:events";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import {
  MEETING_ABANDONED_LOG,
  MEETING_FINISHER_SCAN_LOG,
  MEETING_STUCK_LOG,
} from "../../src/metrics";
import {
  HOUR_SECONDS,
  MS_PER_SECOND,
  NOW,
  SCAN_FAILED_LOG,
  claimedBy,
  finisherRow,
  flush,
  hung,
  isoAt,
  logged,
  row,
  rowsFrom,
  scanLogs,
  setup,
  useFinisherHooks,
} from "./meetingFinisher.fixture";

useFinisherHooks();

test("a scan does nothing on a worker that is not eligible", async () => {
  const world = setup([row("a")]);
  jest.mocked(world.deps.isEligible).mockReturnValue(false);
  await world.scan();
  expect(world.deps.readLease).not.toHaveBeenCalled();
  expect(world.deps.finish).not.toHaveBeenCalled();
  expect(world.current(row("a")).finish).toBeUndefined();
});

test("a scan never overlaps itself", async () => {
  const world = setup([row("a")]);
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scan = jest.spyOn(world.deps.repository, "scan");
  jest.mocked(world.deps.readLease).mockImplementationOnce(async () => {
    await held;
    return undefined;
  });
  const first = world.scan();
  await flush();
  await world.scan();
  expect(scan).toHaveBeenCalledTimes(1);
  release();
  await first;
  await world.scan();
  expect(scan).toHaveBeenCalledTimes(2);
});

test("one failing row does not stop the scan", async () => {
  const world = setup([row("a"), row("b")]);
  jest
    .mocked(world.deps.readLease)
    .mockRejectedValueOnce(new Error("synthetic lease read failure"));
  await world.scan();
  await flush();
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  expect(world.current(row("b")).finish?.owner).toMatch(/^synthetic-worker-b:/);
});

test("stuck and abandoned rows log the alarm lines", async () => {
  const fiveHours = 5 * HOUR_SECONDS;
  const stuck = row("stuck", {
    timestamp: isoAt(NOW - fiveHours),
    finish: { attempts: 1, nextAttemptAt: NOW + 1, phase: "process" },
  });
  const abandoned = row("abandoned", {
    status: "in_progress",
    timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
  });
  const delivering = row("delivering", {
    status: "complete",
    timestamp: isoAt(NOW - fiveHours),
    finish: { attempts: 1, nextAttemptAt: NOW + 1, phase: "deliver" },
  });
  const world = setup([stuck, abandoned, delivering]);

  await world.scan();
  // The abandoned row was still open when scanned, so it logs both lines once.
  expect(logged(MEETING_STUCK_LOG)).toBe(2);
  expect(logged(MEETING_ABANDONED_LOG)).toBe(1);
  expect(jest.mocked(console.error)).toHaveBeenCalledWith(MEETING_STUCK_LOG, {
    guildId: stuck.guildId,
    meetingId: stuck.meetingId,
  });
  expect(world.current(abandoned).status).toBe("failed");
  expect(world.current(abandoned).finish).toBeUndefined();

  await world.scan();
  expect(logged(MEETING_STUCK_LOG)).toBe(3);
  expect(logged(MEETING_ABANDONED_LOG)).toBe(1);
  expect(world.deps.finish).not.toHaveBeenCalled();
});

test("the timer scans on each tick and stop does not wait for a held lease read, which then takes nothing", async () => {
  const world = setup([row("a")]);
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.mocked(world.deps.readLease).mockImplementationOnce(async () => {
    await held;
    return undefined;
  });
  world.loop.startMeetingFinisher();
  expect(world.ticking()).toBe(true);
  world.tick();
  await flush();
  let stopped = false;
  const stopping = world.loop.stopMeetingFinisher().then(() => {
    stopped = true;
  });
  await flush();
  expect(world.ticking()).toBe(false);
  expect(stopped).toBe(true);
  await stopping;
  release();
  await flush();
  expect(world.deps.finish).not.toHaveBeenCalled();
  expect(world.current(row("a")).finish).toBeUndefined();
});

describe("the finisher scan dead-man line", () => {
  test("a completed scan logs the dead-man line at most once a minute, with counts and no identifiers", async () => {
    const waitingRetry = row("b", {
      finish: {
        attempts: 1,
        nextAttemptAt: NOW + HOUR_SECONDS,
        phase: "process",
      },
    });
    const world = setup([row("a"), waitingRetry]);
    await world.scan();
    expect(scanLogs()).toEqual([
      [MEETING_FINISHER_SCAN_LOG, { seen: 2, taken: 1, failed: 0 }],
    ]);
    world.advance(LIFECYCLE.finisherScanLogMs / MS_PER_SECOND - 1);
    await world.scan();
    expect(scanLogs()).toHaveLength(1);
    world.advance(1);
    await world.scan();
    expect(scanLogs()).toEqual([
      [MEETING_FINISHER_SCAN_LOG, { seen: 2, taken: 1, failed: 0 }],
      [MEETING_FINISHER_SCAN_LOG, { seen: 2, taken: 0, failed: 0 }],
    ]);
    await world.settle();
  });

  test("a scan that throws does not log it", async () => {
    const world = setup([row("a")]);
    jest
      .spyOn(world.deps.repository, "scan")
      .mockReturnValue(
        rowsFrom(() => Promise.reject(new Error("synthetic scan failure"))),
      );
    await world.scan();
    expect(scanLogs()).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(SCAN_FAILED_LOG, {
      error: expect.any(Error),
    });
  });
});

describe("a bounded finisher scan", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
  });
  afterEach(() => jest.useRealTimers());

  test("a scan that hangs is abandoned at its deadline and the next tick scans again", async () => {
    const world = setup([row("a")]);
    const scan = jest
      .spyOn(world.deps.repository, "scan")
      .mockReturnValueOnce(rowsFrom(hung));
    world.loop.startMeetingFinisher();
    world.tick();
    await flush();
    world.tick();
    expect(scan).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(LIFECYCLE.finisherScanTimeoutMs);
    expect(console.error).toHaveBeenCalledWith(SCAN_FAILED_LOG, {
      error: expect.any(Error),
    });
    expect(scanLogs()).toHaveLength(0);
    world.tick();
    await flush();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(world.deps.finish).toHaveBeenCalledTimes(1);
    await world.loop.stopMeetingFinisher();
    await world.settle();
  });

  test("a hung lease read does not hold the pass", async () => {
    const world = setup([row("a"), row("b")]);
    jest.mocked(world.deps.readLease).mockImplementationOnce(hung);
    const pass = world.scan();
    await jest.advanceTimersByTimeAsync(LIFECYCLE.finisherLeaseReadMs);
    await pass;
    expect(LIFECYCLE.finisherLeaseReadMs).toBeLessThan(
      LIFECYCLE.finisherScanTimeoutMs,
    );
    expect(world.deps.finish).toHaveBeenCalledTimes(1);
    expect(world.current(row("b")).finish?.owner).toMatch(
      /^synthetic-worker-b:/,
    );
    expect(scanLogs()).toEqual([
      [MEETING_FINISHER_SCAN_LOG, { seen: 2, taken: 1, failed: 1 }],
    ]);
    await world.settle();
  });

  test("a pass woken after its deadline takes no more rows", async () => {
    const world = setup([row("a")]);
    let wake = () => undefined as void;
    const late = new Promise<void>((resolve) => {
      wake = resolve;
    });
    let yielded = false;
    jest.spyOn(world.deps.repository, "scan").mockReturnValue(
      rowsFrom(async () => {
        if (yielded) return { done: true, value: undefined };
        await late;
        yielded = true;
        return { done: false, value: finisherRow(row("a")) };
      }),
    );
    const pass = world.scan();
    await jest.advanceTimersByTimeAsync(LIFECYCLE.finisherScanTimeoutMs);
    await pass;
    wake();
    await flush();
    expect(world.deps.readLease).not.toHaveBeenCalled();
    expect(world.deps.finish).not.toHaveBeenCalled();
  });

  test("stop returns promptly while a scan hangs", async () => {
    const world = setup([row("a")]);
    jest.spyOn(world.deps.repository, "scan").mockReturnValue(rowsFrom(hung));
    world.loop.startMeetingFinisher();
    world.tick();
    await flush();
    let stopped = false;
    void world.loop.stopMeetingFinisher().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(true);
    expect(console.error).not.toHaveBeenCalledWith(
      SCAN_FAILED_LOG,
      expect.anything(),
    );
  });
});

test("a pass in which every row errors logs the scan failure, not the dead-man line", async () => {
  const world = setup([row("a"), row("b")]);
  jest
    .mocked(world.deps.readLease)
    .mockRejectedValue(new Error("synthetic lease permission failure"));
  await world.scan();
  expect(scanLogs()).toHaveLength(0);
  expect(console.error).toHaveBeenCalledWith(SCAN_FAILED_LOG, {
    error: expect.any(Error),
  });
});

test("a non-terminal row older than 24 hours still logs the stuck line", async () => {
  const held = row("a", {
    timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
    finish: claimedBy("synthetic-worker-other:held"),
  });
  const world = setup([held]);
  await world.scan();
  await world.scan();
  expect(logged(MEETING_STUCK_LOG)).toBe(2);
  expect(world.current(held).status).toBe("processing");
});

describe("bounded calls release their abort listeners", () => {
  const listeners = (signal: AbortSignal | undefined) =>
    signal ? getEventListeners(signal, "abort").length : -1;

  test("after a lease read resolves, rejects or misses its deadline, and after the pass", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    try {
      const world = setup([row("a"), row("b"), row("c")]);
      const leaseSignals: AbortSignal[] = [];
      let scanSignal: AbortSignal | undefined;
      const scan = world.deps.repository.scan.bind(world.deps.repository);
      jest.spyOn(world.deps.repository, "scan").mockImplementation((signal) => {
        scanSignal = signal;
        return scan(signal);
      });
      jest
        .mocked(world.deps.readLease)
        .mockImplementationOnce(async (_guildId, signal) => {
          leaseSignals.push(signal);
          return undefined;
        })
        .mockImplementationOnce(async (_guildId, signal) => {
          leaseSignals.push(signal);
          throw new Error("synthetic lease read failure");
        })
        .mockImplementationOnce((_guildId, signal) => {
          leaseSignals.push(signal);
          return hung();
        });
      const pass = world.scan();
      await jest.advanceTimersByTimeAsync(LIFECYCLE.finisherLeaseReadMs);
      await pass;
      expect(leaseSignals).toHaveLength(3);
      expect(leaseSignals.map(listeners)).toEqual([0, 0, 0]);
      expect(listeners(scanSignal)).toBe(0);
      await world.settle();
    } finally {
      jest.useRealTimers();
    }
  });
});
