/** @jest-environment node */
jest.mock("dotenv", () => ({ config: jest.fn() }));
import type { MeetingData } from "../../src/types/meeting-data";
import { createMeetingInterruptionService } from "../../src/services/meetingInterruptionService";
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const local = held<void>();
  const stop = jest.fn(() => local.promise);
  const preserve = jest.fn(async () => ({ kind: "preserved" as const }));
  const release = jest.fn(async () => true);
  const service = createMeetingInterruptionService({ stop, preserve, release });
  const meeting = {
    meetingId: "synthetic",
    guildId: "synthetic",
  } as MeetingData;
  return { service, meeting, local, stop, preserve, release };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});
afterEach(() => jest.useRealTimers());
test.each([true, false])(
  "reconciliation waits actual work and preserves the original budget: %s",
  async (settleFirst) => {
    const f = fixture();
    const original = f.service.interrupt(f.meeting, {
      reason: "capture_failure",
      deadline: 10,
    });
    await jest.advanceTimersByTimeAsync(10);
    expect(await original).toEqual({ kind: "unresolved" });
    const checkpoint = f.service.checkpoints()[0];
    if (settleFirst) {
      f.local.resolve();
      await jest.advanceTimersByTimeAsync(0);
    }
    const release = jest.fn(async () => true);
    const reconcile = f.service.reconcile(f.meeting, 100, release);
    const duplicate = f.service.reconcile(f.meeting, 100, release);
    expect(duplicate).toBe(reconcile);
    if (!settleFirst) {
      expect(release).not.toHaveBeenCalled();
      f.local.resolve();
    }
    expect(await reconcile).toEqual({ kind: "settled" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.preserve).not.toHaveBeenCalled();
    expect(checkpoint.signal.aborted).toBe(true);
    expect(checkpoint.deadline).toBe(10);
    expect(await original).toEqual({ kind: "unresolved" });
    expect(f.service.checkpoints()).toEqual([]);
    expect(await f.service.reconcile(f.meeting, 200, release)).toEqual({
      kind: "settled",
    });
    expect(release).toHaveBeenCalledTimes(1);
  },
);
test("shutdownStopsCaptureWithoutWaitingForNaturalEnd", async () => {
  const f = fixture();
  const pending = f.service.interrupt(f.meeting, {
    reason: "shutdown",
    deadline: 100000,
  });
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.preserve).not.toHaveBeenCalled();
  f.local.resolve();
  expect(await pending).toMatchObject({ kind: "settled" });
  expect(f.release).toHaveBeenCalledTimes(1);
});
test("encoderNeverEndsStillMeetsDeadline without releasing its count", async () => {
  const f = fixture();
  const pending = f.service.interrupt(f.meeting, {
    reason: "shutdown",
    deadline: 100000,
  });
  await jest.advanceTimersByTimeAsync(100000);
  expect(await pending).toMatchObject({ kind: "unresolved" });
  expect(f.release).not.toHaveBeenCalled();
  expect(f.service.checkpoints()[0].localSettled).toBe(false);
  f.local.resolve();
  await jest.runAllTimersAsync();
  expect(f.preserve).not.toHaveBeenCalled();
});
test("overlapping automatic failure and shutdown reuse actual work and earliest deadline", async () => {
  const f = fixture();
  const first = f.service.interrupt(f.meeting, {
    reason: "processing_failure",
    deadline: 100000,
  });
  const second = f.service.interrupt(f.meeting, {
    reason: "shutdown",
    deadline: 50000,
  });
  expect(second).toBe(first);
  f.service.interrupt(f.meeting, { reason: "shutdown", deadline: 200000 });
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.service.checkpoints()[0].deadline).toBe(50000);
  await jest.advanceTimersByTimeAsync(50000);
  expect(await first).toMatchObject({ kind: "unresolved" });
  f.local.resolve();
  await jest.runAllTimersAsync();
});
test("separate preservation task must settle before durable disposition or buffer release", async () => {
  const f = fixture();
  const task = held<boolean>();
  f.meeting.recordingPreservationTask = task.promise;
  const pending = f.service.interrupt(f.meeting, {
    reason: "capture_failure",
    deadline: 100000,
  });
  f.local.resolve();
  await jest.advanceTimersByTimeAsync(1);
  expect(f.preserve).not.toHaveBeenCalled();
  task.resolve(false);
  expect(await pending).toMatchObject({ kind: "settled" });
});
