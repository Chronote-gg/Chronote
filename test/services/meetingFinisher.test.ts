/** @jest-environment node */
jest.mock("../../src/observability/meetingTrace", () => ({
  ...jest.requireActual("../../src/observability/meetingTrace"),
  withMeetingEndTrace: jest.fn(
    async (_meeting: unknown, run: () => Promise<void>) => run(),
  ),
}));
import { getEventListeners } from "node:events";
import { withMeetingEndTrace } from "../../src/observability/meetingTrace";
import {
  createMockMeetingFinishRepository,
  type FinishClaim,
  type FinisherRow,
} from "../../src/repositories/meetingFinishRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import type { FinishInput } from "../../src/services/meetingFinishInput";
import {
  abandonedCaptureEnd,
  captureEndFromManifest,
  classifyFinisherRow,
  createMeetingFinisherLoop,
  type FinisherAction,
  type ManifestTiming,
  type MeetingFinisherDeps,
} from "../../src/services/meetingFinisher";
import {
  createMeetingFinisher,
  type MeetingFinishDeps,
} from "../../src/services/meetingFinish";
import {
  MEETING_ABANDONED_LOG,
  MEETING_FINISHER_SCAN_LOG,
  MEETING_STUCK_LOG,
} from "../../src/metrics";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { MeetingData } from "../../src/types/meeting-data";
import type { RecordingCheckpoint } from "../../src/types/recordingCheckpoint";

const MS_PER_SECOND = 1000;
const HOUR_SECONDS = 3_600;
const GUILD = "synthetic-guild";
const START = "2026-01-01T00:00:00.000Z";
const START_SECONDS = Date.parse(START) / MS_PER_SECOND;
const GRACE = LIFECYCLE.abandonedGraceSeconds;
const CLAIM = LIFECYCLE.finishClaimSeconds;
/** An hour after the meeting started: past every grace, short of every alarm. */
const NOW = START_SECONDS + HOUR_SECONDS;
const SAVED_MINUTES = 7;
const BRIEF_LAPSE_SECONDS = 30;
const SECONDS_PER_MINUTE = 60;

function row(
  id: string,
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory {
  return {
    guildId: `${GUILD}-${id}`,
    channelId_timestamp: `synthetic-voice#${START}#${id}`,
    meetingId: `synthetic-meeting-${id}`,
    channelId: "synthetic-voice",
    timestamp: START,
    participants: [],
    duration: 0,
    transcribeMeeting: true,
    generateNotes: true,
    lifecycleVersion: 2,
    executionVersion: 1,
    ownerInstanceId: "synthetic-worker-old",
    status: "processing",
    ...overrides,
  };
}

function finisherRow(history: MeetingHistory): FinisherRow {
  const {
    guildId,
    channelId_timestamp,
    meetingId,
    status,
    timestamp,
    updatedAt,
    lifecycleVersion,
    finish,
    ownerInstanceId,
  } = history;
  return {
    guildId,
    channelId_timestamp,
    meetingId,
    status,
    timestamp,
    updatedAt,
    lifecycleVersion,
    finish,
    ownerInstanceId,
  };
}

function lease(meetingId: string, leaseExpiresAt: number): ActiveMeetingLease {
  return {
    guildId: GUILD,
    meetingId,
    ownerInstanceId: "synthetic-worker-old",
    voiceChannelId: "synthetic-voice",
    textChannelId: "synthetic-text",
    isAutoRecording: false,
    leaseExpiresAt,
    createdAt: START,
    updatedAt: START,
    expiresAt: leaseExpiresAt + 1,
    sessionMode: "meeting",
    voiceOperationAttemptId: "synthetic-attempt",
    executionVersion: 1,
  };
}

const isoAt = (seconds: number) =>
  new Date(seconds * MS_PER_SECOND).toISOString();

describe("classifyFinisherRow", () => {
  const live = (status: "starting" | "in_progress", sinceSeconds: number) =>
    row("a", { status, updatedAt: isoAt(NOW - sinceSeconds) });
  const cases: Array<
    [string, MeetingHistory, ActiveMeetingLease | undefined, FinisherAction]
  > = [
    [
      "a live lease naming the same meeting",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-a", NOW + 1),
      "skip",
    ],
    [
      "a live lease naming a different meeting",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-next", NOW + 1),
      "adopt",
    ],
    [
      "lease naming this meeting expired 30 seconds ago",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-a", NOW - BRIEF_LAPSE_SECONDS),
      "skip",
    ],
    [
      "lease naming this meeting expired longer than the grace ago",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-a", NOW - GRACE - 1),
      "adopt",
    ],
    [
      "a starting row whose lease lapsed briefly",
      live("starting", GRACE + 1),
      lease("synthetic-meeting-a", NOW - BRIEF_LAPSE_SECONDS),
      "skip",
    ],
    [
      "a claim that is held and unexpired",
      row("a", {
        finish: { owner: "w", expiresAt: NOW, attempts: 0, phase: "process" },
      }),
      undefined,
      "skip",
    ],
    [
      "a claim whose holder stopped renewing",
      row("a", {
        finish: {
          owner: "w",
          expiresAt: NOW - 1,
          attempts: 0,
          phase: "process",
        },
      }),
      undefined,
      "claim",
    ],
    [
      "a retry whose time has not arrived",
      row("a", {
        finish: { attempts: 1, nextAttemptAt: NOW + 1, phase: "process" },
      }),
      undefined,
      "skip",
    ],
    [
      "a retry whose time has arrived",
      row("a", {
        finish: { attempts: 1, nextAttemptAt: NOW, phase: "process" },
      }),
      undefined,
      "claim",
    ],
    ["starting inside the grace", live("starting", GRACE), undefined, "skip"],
    [
      "starting past the grace",
      live("starting", GRACE + 1),
      undefined,
      "adopt",
    ],
    [
      "in progress inside the grace",
      live("in_progress", GRACE),
      undefined,
      "skip",
    ],
    [
      "in progress past the grace",
      live("in_progress", GRACE + 1),
      undefined,
      "adopt",
    ],
    [
      "in progress with no checkpoint, timed from its start",
      row("a", { status: "in_progress", timestamp: isoAt(NOW - GRACE - 1) }),
      undefined,
      "adopt",
    ],
    ["processing and unclaimed", row("a"), undefined, "claim"],
    [
      "terminal with a delivery marker",
      row("a", {
        status: "complete",
        finish: { attempts: 1, phase: "deliver", deliverSince: NOW - 60 },
      }),
      undefined,
      "claim",
    ],
    [
      "terminal with a delivery retry not yet due",
      row("a", {
        status: "complete",
        finish: { attempts: 1, nextAttemptAt: NOW + 1, phase: "deliver" },
      }),
      undefined,
      "skip",
    ],
    [
      "non-terminal past 24 hours",
      row("a", { timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1) }),
      undefined,
      "abandon",
    ],
    [
      "non-terminal past 24 hours with a retry not yet due",
      row("a", {
        timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
        finish: { attempts: 2, nextAttemptAt: NOW + 1, phase: "process" },
      }),
      undefined,
      "abandon",
    ],
    [
      "non-terminal past 24 hours with a claim still held",
      row("a", {
        timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
        finish: { owner: "w", expiresAt: NOW, attempts: 0, phase: "process" },
      }),
      undefined,
      "skip",
    ],
    [
      "terminal with a delivery marker past 24 hours",
      row("a", {
        status: "complete",
        timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
        finish: { attempts: 3, phase: "deliver", deliverSince: NOW - 60 },
      }),
      undefined,
      "claim",
    ],
  ];

  it.each(cases)("%s", (_label, history, currentLease, action) => {
    expect(classifyFinisherRow(finisherRow(history), currentLease, NOW)).toBe(
      action,
    );
  });
});

type Pending = { resolve(): void; claim: FinishClaim };

function setup(
  rows: MeetingHistory[],
  pipeline?: (
    repository: ReturnType<typeof createMockMeetingFinishRepository>,
  ) => MeetingFinisherDeps["finish"],
) {
  const histories = new Map<string, MeetingHistory[]>();
  for (const history of rows)
    histories.set(history.guildId, [
      ...(histories.get(history.guildId) ?? []),
      structuredClone(history),
    ]);
  const leases = new Map<string, ActiveMeetingLease>();
  const repository = createMockMeetingFinishRepository(histories, leases);
  let nowMs = NOW * MS_PER_SECOND;
  let tick: (() => void) | undefined;
  const pending: Pending[] = [];
  const input = {} as FinishInput;
  const deps: MeetingFinisherDeps = {
    repository,
    readLease: jest.fn(async (guildId: string) => leases.get(guildId)),
    // Each attempt stays running until the test resolves it or it is aborted.
    finish: jest.fn(
      pipeline?.(repository) ??
        (async (claim, load, options) => {
          const signal = options?.signal ?? new AbortController().signal;
          await load(signal);
          await new Promise<void>((resolve) => {
            pending.push({ resolve, claim });
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }),
    ),
    loadNormal: jest.fn(async () => input),
    loadRecovery: jest.fn(async () => input),
    readCoverage: jest.fn(async (): Promise<ManifestTiming> => ({
      coverage: {
        kind: "unknown",
        reason: "no_verified_audio",
        detectedAt: START,
      },
      captureStartedAt: START,
      audio: [],
    })),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    isCapturing: jest.fn(() => false),
    endEncoder: jest.fn(async () => undefined),
    isEligible: jest.fn(() => true),
    instanceId: () => "synthetic-worker-b",
    nowMs: () => nowMs,
    every(run) {
      tick = run;
      return () => {
        tick = undefined;
      };
    },
  };
  const loop = createMeetingFinisherLoop(deps);
  const current = (history: MeetingHistory) =>
    histories
      .get(history.guildId)!
      .find((r) => r.channelId_timestamp === history.channelId_timestamp)!;
  return {
    deps,
    loop,
    leases,
    pending,
    current,
    scan: () => loop.runFinisherScan(new AbortController().signal),
    tick: () => tick?.(),
    ticking: () => tick !== undefined,
    advance(seconds: number) {
      nowMs += seconds * MS_PER_SECOND;
    },
    async settle() {
      for (const attempt of pending.splice(0)) attempt.resolve();
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function localMeeting(history: MeetingHistory): MeetingData {
  return {
    meetingId: history.meetingId,
    guildId: history.guildId,
    reservation: {
      guildId: history.guildId,
      meetingId: history.meetingId,
      ownerInstanceId: "synthetic-worker-b",
      executionVersion: 1,
      voiceOperationAttemptId: "synthetic-attempt",
      reservedAt: START_SECONDS * MS_PER_SECOND,
      sessionMode: "meeting",
      historyKey: {
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      },
    },
  } as MeetingData;
}

const claimedBy = (owner: string) =>
  ({
    owner,
    expiresAt: NOW + CLAIM,
    attempts: 0,
    startedAt: NOW,
    phase: "process",
  }) as const;

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const logged = (line: string) =>
  jest.mocked(console.error).mock.calls.filter(([first]) => first === line)
    .length;

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

test("the loop never takes more than the free slots", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([local, row("a"), row("b"), row("c")]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  expect(world.loop.activeFinishCount()).toBe(1);
  await world.scan();
  await flush();
  expect(world.loop.activeFinishCount()).toBe(LIFECYCLE.maxConcurrentFinishes);
  expect(world.deps.finish).toHaveBeenCalledTimes(
    LIFECYCLE.maxConcurrentFinishes,
  );
  await world.settle();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("a local finish always starts, even with every slot taken", async () => {
  const locals = [row("a"), row("b"), row("c")].map((history) => ({
    ...history,
    finish: claimedBy(`synthetic-worker-b:${history.meetingId}`),
  }));
  const world = setup(locals);
  for (const history of locals)
    void world.loop.runLocalFinish(
      localMeeting(history),
      `synthetic-worker-b:${history.meetingId}`,
    );
  await flush();
  expect(world.loop.activeFinishCount()).toBe(locals.length);
  await world.settle();
});

test("a meeting is reported as finishing here only while its attempt runs", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-b:local") });
  const looped = row("b");
  const world = setup([local, looped]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await world.scan();
  await flush();
  expect(world.loop.isFinishing(local.meetingId)).toBe(true);
  expect(world.loop.isFinishing(looped.meetingId)).toBe(true);
  expect(world.loop.isFinishing("synthetic-elsewhere")).toBe(false);
  await world.settle();
  expect(world.loop.isFinishing(local.meetingId)).toBe(false);
  expect(world.loop.isFinishing(looped.meetingId)).toBe(false);
});

test("a meeting this process is already finishing is skipped", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([local]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  // Renewals failed for longer than the claim, so the row looks claimable.
  world.advance(CLAIM + 1);
  await world.scan();
  await flush();
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  expect(world.current(local).finish?.owner).toBe("synthetic-worker-b:local");
  await world.settle();
});

test("the local finish uses the normal loader and a loop attempt uses the recovery loader", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const stranded = row("stranded");
  const world = setup([local, stranded]);
  const meeting = localMeeting(local);
  void world.loop.runLocalFinish(meeting, "synthetic-worker-b:local");
  await flush();
  await world.scan();
  await flush();
  expect(world.deps.loadNormal).toHaveBeenCalledTimes(1);
  expect(world.deps.loadNormal).toHaveBeenCalledWith(
    meeting,
    expect.any(AbortSignal),
  );
  expect(world.deps.loadRecovery).toHaveBeenCalledTimes(1);
  expect(jest.mocked(world.deps.loadRecovery).mock.calls[0][0]).toMatchObject({
    meetingId: stranded.meetingId,
  });
  const [localClaim, loopClaim] = world.pending.map((p) => p.claim);
  expect(localClaim).toMatchObject({
    owner: "synthetic-worker-b:local",
    history: { meetingId: local.meetingId },
  });
  expect(loopClaim.owner).toMatch(/^synthetic-worker-b:[0-9a-f-]{36}$/);
  await world.settle();
});

test("the local finish runs inside the meeting-end trace", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([local]);
  const meeting = localMeeting(local);
  let tracing = false;
  jest
    .mocked(withMeetingEndTrace)
    .mockImplementationOnce(async (_traced, run) => {
      tracing = true;
      try {
        await run();
      } finally {
        tracing = false;
      }
    });
  let finishedInsideTrace: boolean | undefined;
  const finish = jest.mocked(world.deps.finish);
  const held = finish.getMockImplementation();
  finish.mockImplementationOnce((...args) => {
    finishedInsideTrace = tracing;
    return held!(...args);
  });

  const finished = world.loop.runLocalFinish(
    meeting,
    "synthetic-worker-b:local",
  );
  await flush();
  await world.settle();
  await finished;

  expect(withMeetingEndTrace).toHaveBeenCalledWith(
    meeting,
    expect.any(Function),
  );
  expect(finishedInsideTrace).toBe(true);
});

test("a local finish reports whether its normal loader took the meeting", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-b:local") });
  const gone = row("b", { finish: claimedBy("synthetic-worker-c:other") });
  const world = setup([local, gone]);
  const loaded = world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  await world.settle();
  await expect(loaded).resolves.toBe(true);
  await expect(
    world.loop.runLocalFinish(localMeeting(gone), "synthetic-worker-b:local"),
  ).resolves.toBe(false);
});

test.each(["succeeds", "fails in its loader", "finds its claim gone"] as const)(
  "a local finish that %s leaves no encoder behind",
  async (outcome) => {
    const owner = "synthetic-worker-b:local";
    const local = row("a", {
      finish: claimedBy(
        outcome === "finds its claim gone" ? "synthetic-worker-c:other" : owner,
      ),
    });
    const world = setup([local]);
    if (outcome === "fails in its loader")
      jest
        .mocked(world.deps.loadNormal)
        .mockRejectedValue(new Error("synthetic loader failure"));
    const meeting = localMeeting(local);
    const finished = world.loop.runLocalFinish(meeting, owner);
    await flush();
    await world.settle();
    await finished;
    expect(world.deps.endEncoder).toHaveBeenCalledWith(meeting);
  },
);

test("a local finish whose claim is gone does not run", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-c:other") });
  const world = setup([local]);
  await world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  expect(world.deps.finish).not.toHaveBeenCalled();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("each claim carries its own owner", async () => {
  const world = setup([row("a"), row("b")]);
  await world.scan();
  await flush();
  const owners = world.pending.map((p) => p.claim.owner);
  expect(new Set(owners).size).toBe(2);
  await world.settle();
});

const verifiedUntil = (lastConfirmedSeconds: number): ManifestTiming => ({
  coverage: {
    kind: "verified",
    intervals: [
      {
        sourceId: "user:1",
        startOffsetMs: 0,
        durationMs: (lastConfirmedSeconds - START_SECONDS) * MS_PER_SECOND,
      },
    ],
    savedDurationMs: (lastConfirmedSeconds - START_SECONDS) * MS_PER_SECOND,
    lastConfirmedCaptureAt: isoAt(lastConfirmedSeconds),
  },
  captureStartedAt: START,
  audio: [],
});

type AudioPiece = ManifestTiming["audio"][number];
const UNKNOWN_COVERAGE: ManifestTiming["coverage"] = {
  kind: "unknown",
  reason: "source_intervals_unknown",
  detectedAt: START,
};
const START_MS = Date.parse(START);
const PIECE_MS = 20;
/** A saved piece as the capture writes it: timed, and with its sample intervals. */
const piece = (
  lastOffsetMs: number | undefined,
  intervalEndMs: number,
): AudioPiece => ({
  coverage: {
    kind: "known",
    intervals: [
      {
        sourceId: "user:1",
        startOffsetMs: intervalEndMs - PIECE_MS,
        durationMs: PIECE_MS,
      },
    ],
  },
  ...(lastOffsetMs === undefined
    ? {}
    : {
        timing: {
          basis: "sample_cursor_with_observed_gaps",
          observedFirstOffsetMs: 0,
          observedLastOffsetMs: lastOffsetMs,
          maxCursorAdjustmentMs: PIECE_MS,
        },
      }),
});
const manifestWith = (...audio: AudioPiece[]): ManifestTiming => ({
  coverage: UNKNOWN_COVERAGE,
  captureStartedAt: START,
  audio,
});
const LATE_MS = START_MS + HOUR_SECONDS * MS_PER_SECOND;
const at = (offsetMs: number) => new Date(START_MS + offsetMs).toISOString();

describe("captureEndFromManifest", () => {
  test("exact coverage wins over any estimate", () => {
    const manifest = {
      ...verifiedUntil(START_SECONDS + SAVED_MINUTES * SECONDS_PER_MINUTE),
      audio: [piece(50_000_000, 50_000_000)],
    };
    expect(captureEndFromManifest(manifest, isoAt(NOW), LATE_MS)).toEqual({
      confirmedAt: isoAt(START_SECONDS + SAVED_MINUTES * SECONDS_PER_MINUTE),
    });
  });

  test("a piece's last arrival is preferred over its intervals, and the latest piece counts", () => {
    expect(
      captureEndFromManifest(
        manifestWith(piece(5_000, 8_000), piece(6_000, 6_500)),
        isoAt(NOW),
        LATE_MS,
      ),
    ).toEqual({ estimatedAt: at(6_000) });
  });

  test("a piece without timing is estimated from its intervals", () => {
    expect(
      captureEndFromManifest(
        manifestWith(piece(undefined, 8_000), piece(5_000, 5_000)),
        isoAt(NOW),
        LATE_MS,
      ),
    ).toEqual({ estimatedAt: at(8_000) });
  });

  test("the estimate is no later than the row's last write or now, and no earlier than the capture start", () => {
    const manifest = manifestWith(piece(9_000, 9_000));
    expect(captureEndFromManifest(manifest, at(4_000), LATE_MS)).toEqual({
      estimatedAt: at(4_000),
    });
    expect(
      captureEndFromManifest(manifest, isoAt(NOW), START_MS + 3_000),
    ).toEqual({ estimatedAt: at(3_000) });
    expect(
      captureEndFromManifest(
        manifestWith(piece(-500, 20)),
        at(-1_000),
        LATE_MS,
      ),
    ).toEqual({ estimatedAt: START });
  });

  test("no audio pieces, or no capture start, gives no end", () => {
    expect(captureEndFromManifest(manifestWith(), isoAt(NOW), LATE_MS)).toEqual(
      {},
    );
    expect(
      captureEndFromManifest(
        { ...manifestWith(piece(5_000, 5_000)), captureStartedAt: null },
        isoAt(NOW),
        LATE_MS,
      ),
    ).toEqual({});
  });

  test("an estimate sets the duration only: the end time stays unknown", () => {
    const end = abandonedCaptureEnd(
      row("a", { capture: { kind: "capturing", startedAt: START } }),
      { estimatedAt: at(90_000) },
      NOW,
    );
    expect(end).toEqual({
      capture: {
        kind: "interrupted",
        startedAt: START,
        detectedAt: isoAt(NOW),
        endedAt: null,
      },
      endReason: "unknown",
      duration: 90,
    });
    expect(abandonedCaptureEnd(row("a"), {}, NOW).duration).toBe(0);
  });
});

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

test("a local finish for a meeting the loop is already finishing does not start a second attempt", async () => {
  const meeting = row("a");
  const world = setup([meeting]);
  await world.scan();
  await flush();
  expect(world.loop.activeFinishCount()).toBe(1);
  await world.loop.runLocalFinish(
    localMeeting(meeting),
    "synthetic-worker-b:local",
  );
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  expect(world.loop.activeFinishCount()).toBe(1);
  await world.settle();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("shutdown aborts a running attempt before releasing its claim and the attempt makes no further save or Discord call", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const events: string[] = [];
  const posted = jest.fn();
  let save: jest.SpyInstance | undefined;
  const world = setup([local], (repository) => {
    save = jest.spyOn(repository, "save");
    const release = repository.releaseUnclaimed;
    repository.releaseUnclaimed = async (claim) => {
      events.push("released");
      await release(claim);
    };
    return createMeetingFinisher({
      repository,
      transport: new Proxy({} as MeetingFinishDeps["transport"], {
        get: () => posted,
      }),
      upload: jest.fn(),
      notes: jest.fn(),
      summaries: jest.fn(),
      claimUpgrade: jest.fn(async () => undefined),
      followOns: {
        exportToNotion: jest.fn(async () => undefined),
        writeUserIndex: jest.fn(async () => undefined),
        captureCompleted: jest.fn(),
        sendWeeklyLimitNotice: jest.fn(async () => undefined),
      },
      nowMs: () => NOW * MS_PER_SECOND,
      schedule: () => () => undefined,
    }).finishMeeting;
  });
  // The normal loader is mid-way through, for example compiling the transcript.
  jest.mocked(world.deps.loadNormal).mockImplementation(
    (_meeting, signal) =>
      new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            events.push("aborted");
            resolve({ hasSavedAudio: true } as FinishInput);
          },
          { once: true },
        ),
      ),
  );
  const finished = world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();

  await world.loop.releaseLocalFinishClaims();
  await finished;

  expect(events).toEqual(["aborted", "released"]);
  expect(save).not.toHaveBeenCalled();
  expect(posted).not.toHaveBeenCalled();
  expect(world.current(local).finish).toEqual({
    attempts: 0,
    startedAt: NOW,
    phase: "process",
  });
});

test("no attempt starts after shutdown began", async () => {
  const stranded = row("a");
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([stranded, local]);
  const claim = world.deps.repository.claim;
  let letClaimLand = () => undefined as void;
  const landing = new Promise<void>((resolve) => {
    letClaimLand = resolve;
  });
  jest
    .spyOn(world.deps.repository, "claim")
    .mockImplementationOnce(async (...args) => {
      await landing;
      return claim(...args);
    });
  await world.scan();
  expect(world.loop.activeFinishCount()).toBe(1);

  const shutdown = world.loop.releaseLocalFinishClaims();
  letClaimLand();
  await shutdown;
  await world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await world.scan();
  await flush();

  expect(world.deps.finish).not.toHaveBeenCalled();
  expect(world.current(stranded).finish?.owner).toBeUndefined();
  expect(world.current(local).finish?.owner).toBeUndefined();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("shutdown releases claims without counting an attempt", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const retried = row("retried", {
    finish: { attempts: 2, nextAttemptAt: NOW, phase: "process" },
  });
  const world = setup([local, retried]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  await world.scan();
  await flush();
  expect(world.loop.activeFinishCount()).toBe(2);

  await world.loop.releaseLocalFinishClaims();

  expect(world.current(local).finish).toEqual({
    attempts: 0,
    startedAt: NOW,
    phase: "process",
  });
  expect(world.current(retried).finish).toEqual({
    attempts: 2,
    startedAt: NOW,
    phase: "process",
  });
  // Another worker may take them at once.
  expect(
    classifyFinisherRow(finisherRow(world.current(local)), undefined, NOW),
  ).toBe("claim");
  world.advance(1);
  await world.scan();
  await flush();
  expect(world.deps.finish).toHaveBeenCalledTimes(2);
  await world.settle();
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

const SCAN_FAILED_LOG = "Meeting finisher scan failed";
const scanLogs = () =>
  jest
    .mocked(console.log)
    .mock.calls.filter(([first]) => first === MEETING_FINISHER_SCAN_LOG);
/** A read that never settles and ignores its abort signal. */
const hung = <T>() => new Promise<T>(() => undefined);
const rowsFrom = (
  next: () => Promise<IteratorResult<FinisherRow>>,
): AsyncIterable<FinisherRow> => ({
  [Symbol.asyncIterator]: () => ({ next }),
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

test("a row this process is finishing still logs the stuck line", async () => {
  const local = row("a", {
    timestamp: isoAt(NOW - LIFECYCLE.stuckAlarmSeconds - 1),
    finish: claimedBy("synthetic-worker-b:local"),
  });
  const world = setup([local]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  await world.scan();
  expect(logged(MEETING_STUCK_LOG)).toBe(1);
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  await world.settle();
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
