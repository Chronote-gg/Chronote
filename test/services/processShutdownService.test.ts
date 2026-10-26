/** @jest-environment node */
import { EventEmitter } from "node:events";
import { createProcessShutdownOwner } from "../../src/services/processShutdownService";
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const processSignals = new EventEmitter();
  const exit = jest.fn();
  const pending = held<boolean>();
  const closeAdmission = jest.fn();
  const preserve = jest.fn(() => pending.promise);
  const flush = jest.fn(async () => {});
  const owner = createProcessShutdownOwner({
    closeAdmission,
    preserve,
    flush,
    exit,
  });
  owner.installSignalHandlers(processSignals);
  return {
    owner,
    processSignals,
    exit,
    pending,
    closeAdmission,
    preserve,
    flush,
  };
}
beforeEach(() => jest.useFakeTimers({ now: 1_000 }));
afterEach(() => jest.useRealTimers());
test("shutdownStopsCaptureWithoutWaitingForNaturalEnd and registers before reentrant signals", async () => {
  const f = fixture();
  f.closeAdmission.mockImplementation(() => f.processSignals.emit("SIGINT"));
  f.processSignals.emit("SIGTERM");
  expect(f.closeAdmission).toHaveBeenCalledTimes(1);
  expect(f.preserve).toHaveBeenCalledTimes(1);
  expect(f.owner.startupSignal.aborted).toBe(true);
  expect(f.exit).not.toHaveBeenCalled();
  f.pending.resolve(true);
  await f.owner.request("signal");
  expect(f.flush).toHaveBeenCalledTimes(1);
  expect(f.exit).toHaveBeenCalledWith(0);
  f.owner.dispose();
});
test("oneDeadlineAcrossConcurrentMeetings and a later signal cannot renew protection-loss grace", async () => {
  const f = fixture();
  const original = f.owner.request("protection_loss");
  const budget = f.preserve.mock.calls[0][0];
  expect(budget.deadline).toBe(101_000);
  await jest.advanceTimersByTimeAsync(90_000);
  expect(f.owner.request("signal")).toBe(original);
  expect(f.preserve.mock.calls[0][0]).toBe(budget);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(await original).toEqual({ kind: "unresolved" });
  expect(f.owner.checkpoint().actualSettled).toBe(false);
  expect(f.exit).toHaveBeenCalledTimes(1);
  expect(f.exit).toHaveBeenCalledWith(1);
  f.pending.resolve(true);
  await f.owner.checkpoint().actual;
  expect(f.exit).toHaveBeenCalledTimes(1);
  f.owner.dispose();
});
test("pendingInitializationSettlesBeforeExit including a held startup operation", async () => {
  const f = fixture();
  const startup = held<void>();
  const actualStartup = f.owner.runStartup(() => startup.promise);
  const stopping = f.owner.request("signal");
  f.pending.resolve(true);
  await jest.advanceTimersByTimeAsync(10);
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.flush).not.toHaveBeenCalled();
  startup.resolve();
  await actualStartup;
  expect(await stopping).toEqual({ kind: "settled" });
  expect(f.exit).toHaveBeenCalledWith(0);
  f.owner.dispose();
});
test("encoderNeverEndsStillMeetsDeadline while actual work remains unresolved", async () => {
  const f = fixture();
  const stopping = f.owner.request("signal");
  await jest.advanceTimersByTimeAsync(100_000);
  expect(await stopping).toEqual({ kind: "unresolved" });
  expect(f.owner.checkpoint().actualSettled).toBe(false);
  expect(f.flush).not.toHaveBeenCalled();
  expect(f.exit).toHaveBeenCalledWith(1);
  f.pending.resolve(false);
  await f.owner.checkpoint().actual;
  f.owner.dispose();
});
test("protection loss alone preserves without exit; later startup failure joins without new budget", async () => {
  const f = fixture();
  const stopping = f.owner.request("protection_loss");
  f.pending.resolve(true);
  await stopping;
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.owner.request("startup_failure")).toBe(stopping);
  await stopping;
  expect(f.exit).toHaveBeenCalledWith(1);
  expect(f.preserve).toHaveBeenCalledTimes(1);
  f.owner.dispose();
});
test("a held telemetry flush consumes the same budget and is retained after expiry", async () => {
  const f = fixture();
  const telemetry = held<void>();
  f.flush.mockImplementation(() => telemetry.promise);
  const stopping = f.owner.request("signal");
  f.pending.resolve(true);
  await jest.advanceTimersByTimeAsync(1);
  expect(f.flush).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(99_999);
  expect(await stopping).toEqual({ kind: "unresolved" });
  expect(f.owner.checkpoint().actualSettled).toBe(false);
  telemetry.resolve();
  await f.owner.checkpoint().actual;
  f.owner.dispose();
});
