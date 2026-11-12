import {
  createMockMeetingFinishRepository,
  type FinishClaim,
  type FinisherRow,
} from "../../src/repositories/meetingFinishRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import type { FinishInput } from "../../src/services/meetingFinishInput";
import {
  createMeetingFinisherLoop,
  type ManifestTiming,
  type MeetingFinisherDeps,
} from "../../src/services/meetingFinisher";
import { MEETING_FINISHER_SCAN_LOG } from "../../src/metrics";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { MeetingData } from "../../src/types/meeting-data";

export const MS_PER_SECOND = 1000;
export const HOUR_SECONDS = 3_600;
export const GUILD = "synthetic-guild";
export const START = "2026-01-01T00:00:00.000Z";
export const START_SECONDS = Date.parse(START) / MS_PER_SECOND;
export const GRACE = LIFECYCLE.abandonedGraceSeconds;
export const CLAIM = LIFECYCLE.finishClaimSeconds;
/** An hour after the meeting started: past every grace, short of every alarm. */
export const NOW = START_SECONDS + HOUR_SECONDS;
export const SAVED_MINUTES = 7;
export const BRIEF_LAPSE_SECONDS = 30;
export const SECONDS_PER_MINUTE = 60;

export function row(
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

export function finisherRow(history: MeetingHistory): FinisherRow {
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

export function lease(
  meetingId: string,
  leaseExpiresAt: number,
): ActiveMeetingLease {
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

export const isoAt = (seconds: number) =>
  new Date(seconds * MS_PER_SECOND).toISOString();

export type Pending = { resolve(): void; claim: FinishClaim };

export function setup(
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

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function localMeeting(history: MeetingHistory): MeetingData {
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

export const claimedBy = (owner: string) =>
  ({
    owner,
    expiresAt: NOW + CLAIM,
    attempts: 0,
    startedAt: NOW,
    phase: "process",
  }) as const;

export function useFinisherHooks() {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
}

export const logged = (line: string) =>
  jest.mocked(console.error).mock.calls.filter(([first]) => first === line)
    .length;

export const verifiedUntil = (
  lastConfirmedSeconds: number,
): ManifestTiming => ({
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

export type AudioPiece = ManifestTiming["audio"][number];
export const UNKNOWN_COVERAGE: ManifestTiming["coverage"] = {
  kind: "unknown",
  reason: "source_intervals_unknown",
  detectedAt: START,
};
export const START_MS = Date.parse(START);
export const PIECE_MS = 20;
/** A saved piece as the capture writes it: timed, and with its sample intervals. */
export const piece = (
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
export const manifestWith = (...audio: AudioPiece[]): ManifestTiming => ({
  coverage: UNKNOWN_COVERAGE,
  captureStartedAt: START,
  audio,
});
export const LATE_MS = START_MS + HOUR_SECONDS * MS_PER_SECOND;
export const at = (offsetMs: number) =>
  new Date(START_MS + offsetMs).toISOString();

export const SCAN_FAILED_LOG = "Meeting finisher scan failed";
export const scanLogs = () =>
  jest
    .mocked(console.log)
    .mock.calls.filter(([first]) => first === MEETING_FINISHER_SCAN_LOG);
/** A read that never settles and ignores its abort signal. */
export const hung = <T>() => new Promise<T>(() => undefined);
export const rowsFrom = (
  next: () => Promise<IteratorResult<FinisherRow>>,
): AsyncIterable<FinisherRow> => ({
  [Symbol.asyncIterator]: () => ({ next }),
});
