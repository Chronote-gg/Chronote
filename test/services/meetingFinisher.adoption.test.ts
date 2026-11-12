/** @jest-environment node */
import type { RecordingCheckpoint } from "../../src/types/recordingCheckpoint";
import {
  BRIEF_LAPSE_SECONDS,
  GRACE,
  MS_PER_SECOND,
  NOW,
  SAVED_MINUTES,
  SECONDS_PER_MINUTE,
  START,
  START_SECONDS,
  flush,
  isoAt,
  lease,
  manifestWith,
  piece,
  row,
  setup,
  useFinisherHooks,
  verifiedUntil,
} from "./meetingFinisher.fixture";

useFinisherHooks();

test("an adopted meeting ends interrupted at the last capture its checkpoint confirms", async () => {
  const lastConfirmed = START_SECONDS + SAVED_MINUTES * SECONDS_PER_MINUTE;
  const checkpoint = { revision: 3 } as RecordingCheckpoint;
  const abandoned = row("a", {
    status: "in_progress",
    updatedAt: isoAt(NOW - GRACE - 1),
    capture: { kind: "capturing", startedAt: START },
    checkpoint,
  });
  const fresh = row("b", {
    status: "starting",
    updatedAt: isoAt(NOW - GRACE),
  });
  const world = setup([abandoned, fresh]);
  jest
    .mocked(world.deps.readCoverage)
    .mockResolvedValue(verifiedUntil(lastConfirmed));
  world.leases.set(
    abandoned.guildId,
    lease(abandoned.meetingId, NOW - GRACE - 1),
  );
  await world.scan();
  await flush();
  expect(world.deps.readCoverage).toHaveBeenCalledWith(
    checkpoint,
    expect.any(AbortSignal),
  );
  expect(world.current(abandoned)).toMatchObject({
    status: "processing",
    endReason: "unknown",
    duration: SAVED_MINUTES * SECONDS_PER_MINUTE,
    capture: {
      kind: "interrupted",
      startedAt: START,
      endedAt: isoAt(lastConfirmed),
      detectedAt: isoAt(NOW),
    },
    finish: { owner: expect.stringMatching(/^synthetic-worker-b:/) },
  });
  // A start inside its grace is left alone.
  expect(world.current(fresh).status).toBe("starting");
  await world.settle();
});

test("a capture whose last piece was saved inside the grace is not adopted even when its lease has lapsed and updatedAt is old", async () => {
  const recording = row("a", {
    status: "in_progress",
    updatedAt: isoAt(NOW - 10 * SECONDS_PER_MINUTE),
    capture: { kind: "capturing", startedAt: START },
    checkpoint: { revision: 9 } as RecordingCheckpoint,
  });
  const world = setup([recording]);
  jest
    .mocked(world.deps.readCoverage)
    .mockResolvedValue(verifiedUntil(NOW - GRACE));
  world.leases.set(recording.guildId, lease(recording.meetingId, NOW - 1));
  await world.scan();
  await flush();
  expect(world.current(recording)).toEqual(recording);
  expect(world.deps.finish).not.toHaveBeenCalled();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("a meeting whose checkpoint manifest cannot be read is adopted with no end time", async () => {
  const abandoned = row("a", {
    status: "in_progress",
    updatedAt: isoAt(NOW - GRACE - 1),
    checkpoint: { revision: 2 } as RecordingCheckpoint,
  });
  const world = setup([abandoned]);
  jest
    .mocked(world.deps.readCoverage)
    .mockRejectedValue(new Error("synthetic manifest read failure"));
  await world.scan();
  await flush();
  expect(world.current(abandoned)).toMatchObject({
    status: "processing",
    duration: 0,
    capture: { kind: "interrupted", endedAt: null },
  });
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  await world.settle();
});

test("an adopted meeting with no confirmed capture counts zero duration", async () => {
  const abandoned = row("a", {
    status: "starting",
    updatedAt: isoAt(NOW - GRACE - 1),
  });
  const world = setup([abandoned]);
  await world.scan();
  await flush();
  expect(world.deps.readCoverage).not.toHaveBeenCalled();
  expect(world.current(abandoned)).toMatchObject({
    status: "processing",
    duration: 0,
    capture: { kind: "interrupted", startedAt: null, endedAt: null },
  });
  await world.settle();
});

test("an adopted meeting whose coverage is unknown counts its estimated duration and keeps its end time unknown", async () => {
  const lastWriteSeconds = NOW - GRACE - 1;
  const abandoned = row("a", {
    status: "in_progress",
    updatedAt: isoAt(lastWriteSeconds),
    capture: { kind: "capturing", startedAt: START },
    checkpoint: { revision: 4 } as RecordingCheckpoint,
  });
  const world = setup([abandoned]);
  const spokeUntilMs = SAVED_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
  jest
    .mocked(world.deps.readCoverage)
    .mockResolvedValue(manifestWith(piece(spokeUntilMs, spokeUntilMs)));
  await world.scan();
  await flush();
  expect(world.current(abandoned)).toMatchObject({
    status: "processing",
    duration: SAVED_MINUTES * SECONDS_PER_MINUTE,
    capture: { kind: "interrupted", startedAt: START, endedAt: null },
  });
  expect(world.current(abandoned).captureCoverage).toBeUndefined();
  await world.settle();
});

test("a silent live capture whose lease lapsed briefly is not adopted", async () => {
  const silent = row("a", {
    status: "in_progress",
    updatedAt: isoAt(NOW - 10 * SECONDS_PER_MINUTE),
    capture: { kind: "capturing", startedAt: START },
    checkpoint: { revision: 5 } as RecordingCheckpoint,
  });
  const world = setup([silent]);
  // Nobody spoke for minutes and the manifest is unreadable in an outage.
  jest
    .mocked(world.deps.readCoverage)
    .mockRejectedValue(new Error("synthetic manifest outage"));
  world.leases.set(
    silent.guildId,
    lease(silent.meetingId, NOW - BRIEF_LAPSE_SECONDS),
  );
  await world.scan();
  await flush();
  expect(world.current(silent)).toEqual(silent);
  expect(world.deps.finish).not.toHaveBeenCalled();
});

test("a meeting this process is still capturing is never adopted", async () => {
  const own = row("a", {
    status: "in_progress",
    updatedAt: isoAt(NOW - GRACE - 1),
  });
  const world = setup([own]);
  jest
    .mocked(world.deps.isCapturing)
    .mockImplementation((meetingId) => meetingId === own.meetingId);
  await world.scan();
  await flush();
  expect(world.deps.isCapturing).toHaveBeenCalledWith(own.meetingId);
  expect(world.deps.readLease).not.toHaveBeenCalled();
  expect(world.current(own)).toEqual(own);
  expect(world.deps.finish).not.toHaveBeenCalled();
});
