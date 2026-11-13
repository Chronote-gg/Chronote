import { afterEach, beforeEach, jest } from "@jest/globals";
import type { VoiceConnection } from "@discordjs/voice";
import {
  createMeetingClose,
  type MeetingCloseDeps,
} from "../../src/services/meetingClose";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SessionReservation } from "../../src/types/meetingHistoryTransition";

/** Synthetic meetings and a meeting close wired to recording fakes, shared by the meetingClose suites. */
export const GUILD = "synthetic-guild";
export const NOW_MS = 1_800_000_000_000;
export const START_MS = NOW_MS - 90_000;
export const INSTANCE = "synthetic-instance";

export function reservationFor(
  meetingId: string,
  sessionMode: "meeting" | "tts_only" = "meeting",
): SessionReservation {
  const shared = {
    guildId: GUILD,
    meetingId,
    ownerInstanceId: INSTANCE,
    executionVersion: 1,
    voiceOperationAttemptId: `${meetingId}-attempt`,
    reservedAt: START_MS,
  };
  return sessionMode === "meeting"
    ? {
        ...shared,
        sessionMode,
        historyKey: {
          guildId: GUILD,
          channelId_timestamp: `synthetic-voice#${meetingId}`,
        },
      }
    : { ...shared, sessionMode };
}

export function meetingFor(
  meetingId = "synthetic-meeting-a",
  sessionMode: "meeting" | "tts_only" = "meeting",
): MeetingData {
  const meeting = {
    meetingId,
    guildId: GUILD,
    sessionMode,
    reservation: reservationFor(meetingId, sessionMode),
    connection: { synthetic: meetingId } as unknown as VoiceConnection,
    startTime: new Date(START_MS),
    finishing: false,
    finished: false,
    recordingCaptureState: {
      kind: "capturing",
      startedAt: new Date(START_MS).toISOString(),
    },
  };
  return meeting as unknown as MeetingData;
}

export const never = () => new Promise<never>(() => undefined);

export type D = MeetingCloseDeps;

export function setup(live: MeetingData[] = [], overrides: Partial<D> = {}) {
  const calls: string[] = [];
  const meetings = [...live];
  let cap: number | undefined;
  const record = (name: string) => () => {
    calls.push(name);
  };
  const deps = {
    lease: {
      confirmSessionLease: jest.fn<D["lease"]["confirmSessionLease"]>(
        async () => {
          calls.push("confirm");
          return "held";
        },
      ),
      releaseSessionLease: jest.fn<D["lease"]["releaseSessionLease"]>(
        async () => record("release")(),
      ),
      latestLeaseCap: jest.fn<D["lease"]["latestLeaseCap"]>(() => cap),
      holdsSessionLease: jest.fn<D["lease"]["holdsSessionLease"]>(() => true),
      confirmedLeaseExpiry: jest.fn<D["lease"]["confirmedLeaseExpiry"]>(
        () => NOW_MS / 1000 + 20,
      ),
    },
    finish: {
      recordCaptureEnd: jest.fn<D["finish"]["recordCaptureEnd"]>(async () => {
        calls.push("record");
        return true;
      }),
    },
    stopCapture: jest.fn<D["stopCapture"]>((meeting, disposition) => {
      calls.push(`stop:${disposition}`);
      const startedAt = new Date(START_MS).toISOString();
      const endedAt = new Date(NOW_MS).toISOString();
      if (meeting.recordingCaptureState?.kind !== "capturing") return;
      meeting.recordingCaptureState =
        disposition === "complete"
          ? { kind: "complete", startedAt, endedAt }
          : { kind: "interrupted", startedAt, endedAt, detectedAt: endedAt };
    }),
    leaveVoice: jest.fn<D["leaveVoice"]>(record("leave")),
    dropVoiceLocally: jest.fn<D["dropVoiceLocally"]>(record("drop-voice")),
    restoreNickname: jest.fn<D["restoreNickname"]>(async () =>
      record("nickname")(),
    ),
    flushCapture: jest.fn<D["flushCapture"]>(async () => {
      calls.push("flush");
      return true;
    }),
    prepareLocalFinish: jest.fn<D["prepareLocalFinish"]>(async () =>
      record("prepare")(),
    ),
    retireCapture: jest.fn<D["retireCapture"]>((_meeting, lost) => {
      calls.push(lost ? "retire:lost" : "retire");
    }),
    dropMeeting: jest.fn<D["dropMeeting"]>((meeting) => {
      calls.push("drop");
      const index = meetings.indexOf(meeting);
      if (index >= 0) meetings.splice(index, 1);
    }),
    liveMeetings: () => [...meetings],
    releaseCaptureProtection: jest.fn<D["releaseCaptureProtection"]>(
      record("unprotect"),
    ),
    isEligible: jest.fn<D["isEligible"]>(() => true),
    isShuttingDown: jest.fn<D["isShuttingDown"]>(() => false),
    instanceId: () => INSTANCE,
    localFinishStarter: jest.fn<D["localFinishStarter"]>(),
    endEncoder: jest.fn<D["endEncoder"]>(async () => record("end-encoder")()),
    nowMs: () => NOW_MS,
    sleep: jest.fn<D["sleep"]>(() => never()),
  } satisfies D;
  const starter = jest.fn<ReturnType<D["localFinishStarter"]>>(async () => {
    calls.push("finish");
    return true;
  });
  deps.localFinishStarter.mockReturnValue(starter);
  const close = createMeetingClose({ ...deps, ...overrides });
  return {
    deps,
    calls,
    starter,
    close,
    setCap(value: number | undefined) {
      cap = value;
    },
    recorded: () => deps.finish.recordCaptureEnd.mock.calls.map(([i]) => i),
  };
}

export const button = {
  endReason: "button" as const,
  endTriggeredByUserId: "u-1",
};

/** Keeps the close's expected warnings and errors out of the test output. */
export function useSilencedCloseLogs() {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
}
