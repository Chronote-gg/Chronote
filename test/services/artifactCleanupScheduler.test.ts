/** @jest-environment node */
import { createArtifactCleanupScheduler } from "../../src/services/artifactCleanupScheduler";
import type { CleanupReceiptResult } from "../../src/services/artifactCleanupReceipt";

const pending: CleanupReceiptResult = {
  kind: "pending",
  removed: 0,
  byteLength: 0,
  error: new Error("Disk busy"),
  createdAt: "2026-11-03T12:00:00Z",
  remainingBytes: 128,
  remainingFiles: 2,
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-03T12:01:00Z"));
});
afterEach(() => {
  jest.useRealTimers();
});

test("safe cleanup failures retry a bounded number of times and expose only aggregate metrics", async () => {
  const reconcile = jest.fn(async (): Promise<CleanupReceiptResult> => pending);
  const observe = jest.fn();
  const scheduler = createArtifactCleanupScheduler({ reconcile, observe });
  await scheduler.enqueue("private-directory");
  expect(observe).toHaveBeenLastCalledWith({
    pendingDirectories: 1,
    blockedDirectories: 0,
    pendingBytes: 128,
    pendingFiles: 2,
    oldestAgeSeconds: 60,
  });
  await jest.advanceTimersByTimeAsync(5 * 30_000);
  expect(reconcile).toHaveBeenCalledTimes(4);
  expect(jest.getTimerCount()).toBe(0);
  await scheduler.seal();
});

test("sealing drains actual cleanup and rejects later mutations until explicitly resumed", async () => {
  let finish!: (value: CleanupReceiptResult) => void;
  const reconcile = jest.fn(
    () =>
      new Promise<CleanupReceiptResult>((resolve) => {
        finish = resolve;
      }),
  );
  const scheduler = createArtifactCleanupScheduler({
    reconcile,
    observe: jest.fn(),
  });
  const accepted = scheduler.enqueue("directory");
  await Promise.resolve();
  let sealed = false;
  const sealing = scheduler.seal().then(() => {
    sealed = true;
  });
  await Promise.resolve();
  expect(sealed).toBe(false);
  await expect(scheduler.enqueue("late")).rejects.toThrow("sealed");
  finish(pending);
  await accepted;
  await sealing;
  expect(jest.getTimerCount()).toBe(0);
  scheduler.resume();
  expect(jest.getTimerCount()).toBe(1);
  await scheduler.seal();
});

test("a blocked retry stops periodic deletion attempts and retains the obligation", async () => {
  const reconcile = jest
    .fn<Promise<CleanupReceiptResult>, [string]>()
    .mockResolvedValueOnce(pending)
    .mockResolvedValue({ kind: "blocked", error: new Error("Changed bytes") });
  const observe = jest.fn();
  const scheduler = createArtifactCleanupScheduler({ reconcile, observe });
  await scheduler.enqueue("directory");
  await jest.advanceTimersByTimeAsync(60_000);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
  expect(observe).toHaveBeenLastCalledWith(
    expect.objectContaining({ pendingDirectories: 1 }),
  );
  await scheduler.seal();
});

test("an initially blocked cleanup stays visible without automatic deletion retries", async () => {
  const reconcile = jest
    .fn<Promise<CleanupReceiptResult>, [string]>()
    .mockResolvedValueOnce({
      kind: "blocked",
      error: new Error("Verification unavailable"),
    })
    .mockResolvedValue({ kind: "cleaned", removed: 1, byteLength: 128 });
  const observe = jest.fn();
  const scheduler = createArtifactCleanupScheduler({ reconcile, observe });
  await scheduler.enqueue("directory");
  expect(observe).toHaveBeenLastCalledWith(
    expect.objectContaining({ pendingDirectories: 1, blockedDirectories: 1 }),
  );
  await jest.advanceTimersByTimeAsync(5 * 30_000);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  expect((await scheduler.enqueue("directory")).kind).toBe("cleaned");
  expect(observe).toHaveBeenLastCalledWith(
    expect.objectContaining({ pendingDirectories: 0, blockedDirectories: 0 }),
  );
  await scheduler.seal();
});
