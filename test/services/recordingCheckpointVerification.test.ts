/** @jest-environment node */

jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { createPreservationBudget } from "../../src/services/preservationBudget";
import { history } from "../deployment/controlFixtures";
import {
  capture,
  digest,
  segment,
  ownership,
  fixture,
  input,
} from "../fixtures/recordingCheckpoint";

async function savedContextCheckpoint(count: number) {
  const f = fixture();
  const bytes = Buffer.from("{}");
  const artifacts = Array.from({ length: count }, (_, sequence) => ({
    ...segment,
    kind: "context" as const,
    sequence,
    bytes,
    checksumSha256: digest(bytes),
    contentType: "application/json",
  }));
  const saved = await f.service.flush({ ...input, artifacts });
  if (saved.kind !== "committed") throw new Error("fixture commit failed");
  return { ...f, checkpoint: saved.checkpoint };
}

test("3957 verified objects reach terminal preservation within the existing owner budget", async () => {
  jest.useFakeTimers();
  const f = await savedContextCheckpoint(3957);
  const budget = createPreservationBudget(Date.now() + 100_000);
  try {
    const row = f.histories.get(history.guildId)![0];
    row.status = "processing";
    f.leases.get(history.guildId)!.leaseExpiresAt =
      Math.floor(Date.now() / 1000) + 180;
    let inFlight = 0;
    let peak = 0;
    f.read.mockClear();
    f.read.mockImplementation(async (key) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return f.objects.get(key);
      } finally {
        inFlight--;
      }
    });
    const result = (async () => {
      await f.service.read(f.checkpoint, budget.signal);
      return f.service.preserveInitialTerminalRecordingCheckpoint({
        ...input,
        previous: f.checkpoint,
        artifacts: [],
        expectedStatus: "processing",
        status: "failed",
        captureState: {
          kind: "complete",
          startedAt: capture.captureStartedAt!,
          endedAt: "2026-01-01T00:00:03.000Z",
        },
        recovery: {
          disposition: "pending",
          attempt: 0,
          executionVersion: 1,
          stage: "verification",
          retry: { maxAttempts: 3, nextAttemptAt: null },
        },
        preservation: {
          ownership,
          signal: budget.signal,
          deadlineEpochMs: budget.deadline,
          assertOwnership: async () => {},
        },
      });
    })().catch(() => ({ kind: "rejected" }));
    await jest.advanceTimersByTimeAsync(100_001);
    expect(await result).toMatchObject({ kind: "committed" });
    expect(row.status).toBe("failed");
    expect(peak).toBeLessThanOrEqual(16);
    expect(inFlight).toBe(0);
    expect(
      f.read.mock.calls.filter(([key]) => !key.includes("/manifests/")),
    ).toHaveLength(3957 * 3);
  } finally {
    budget.dispose();
    jest.useRealTimers();
  }
});

test("failed verification settles issued reads and never dispatches the next batch", async () => {
  const f = await savedContextCheckpoint(20);
  const { manifest } = await f.service.read(f.checkpoint);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = false;
  f.read.mockClear();
  f.read.mockImplementation(async (key) => {
    if (key === f.checkpoint.manifest.key) return f.objects.get(key);
    if (key === manifest.artifacts[0].object.key)
      throw new Error("Synthetic read failure");
    await pending;
    return f.objects.get(key);
  });
  const reading = f.service.read(f.checkpoint).then(
    () => {
      completed = true;
      return "fulfilled";
    },
    () => {
      completed = true;
      return "rejected";
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(
      f.read.mock.calls.filter(([key]) => key !== f.checkpoint.manifest.key),
    ).toHaveLength(16);
    release();
    expect(await reading).toBe("rejected");
    expect(
      f.read.mock.calls.filter(([key]) => key !== f.checkpoint.manifest.key),
    ).toHaveLength(16);
  } finally {
    release();
    await reading;
  }
});

test("parallel verification preserves order and rejects absent, wrong-size and same-size corrupt objects", async () => {
  const f = await savedContextCheckpoint(20);
  const { manifest } = await f.service.read(f.checkpoint);
  f.objects.delete(manifest.artifacts[1].object.key);
  f.objects.set(manifest.artifacts[8].object.key, Buffer.from("[ ]"));
  f.objects.set(manifest.artifacts[17].object.key, Buffer.from("[]"));
  const verified = await f.service.read(f.checkpoint);
  expect(verified.missing.map(({ sequence }) => sequence)).toEqual([1, 8, 17]);
  expect(verified.verified.map(({ sequence }) => sequence)).toEqual([
    0, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19,
  ]);
});
