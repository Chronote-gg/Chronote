/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import { getVoiceConnection, type VoiceConnection } from "@discordjs/voice";
import type { MeetingInitOptions } from "../../src/meetings";
import {
  createMeetingStart,
  type MeetingStartDeps,
} from "../../src/services/meetingStart";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import type { AcquireSessionLeaseInput } from "../../src/services/meetingLease";
import type { LeaseRenewalHooks } from "../../src/services/meetingLease";
import { joinVoice } from "../../src/services/voiceSession";
import { fakeVoiceGuild } from "./voiceSession.fixture";
import type { ActiveMeetingLease } from "../../src/types/db";
import type { MeetingData } from "../../src/types/meeting-data";
import type {
  HistoryTransition,
  SessionReservation,
} from "../../src/types/meetingHistoryTransition";

const GUILD = "synthetic-guild";
const MEETING = "synthetic-meeting";
const NOW_MS = 1_800_000_000_000;
const MS_PER_SECOND = 1000;
/** As the lease service reports right after acquiring: confirmed one lease term ahead. */
const CONFIRMED_UNTIL = NOW_MS / MS_PER_SECOND + LIFECYCLE.leaseSeconds;

function reservationFor(input: AcquireSessionLeaseInput): SessionReservation {
  const shared = {
    guildId: input.guildId,
    meetingId: input.meetingId,
    ownerInstanceId: "synthetic-owner",
    executionVersion: 1,
    voiceOperationAttemptId: "synthetic-attempt",
    reservedAt: input.reservedAt,
  };
  return input.sessionMode === "meeting"
    ? {
        ...shared,
        sessionMode: "meeting",
        historyKey: {
          guildId: input.guildId,
          channelId_timestamp: input.history.channelId_timestamp,
        },
      }
    : { ...shared, sessionMode: "tts_only" };
}

function options(
  overrides: Partial<MeetingInitOptions> = {},
): MeetingInitOptions {
  const partial: Partial<MeetingInitOptions> = {
    meetingId: MEETING,
    reservedAt: NOW_MS,
    voiceChannel: { id: "synthetic-voice", name: "Voice" } as never,
    textChannel: { id: "synthetic-text" } as never,
    guild: { id: GUILD } as never,
    creator: { id: "synthetic-user" } as never,
    transcribeMeeting: true,
    generateNotes: true,
    ...overrides,
  };
  return partial as MeetingInitOptions;
}

function setup() {
  const calls: string[] = [];
  const deadline = new AbortController();
  const connection = { synthetic: "connection" } as unknown as VoiceConnection;
  const meeting = {
    meetingId: MEETING,
    guildId: GUILD,
    finished: false,
    finishing: false,
    participants: new Map(),
  } as unknown as MeetingData;
  let hooks: LeaseRenewalHooks | undefined;
  let ownershipSignal: AbortSignal | undefined;
  const captureEnd = { onLost: jest.fn(), onCapReached: jest.fn() };
  const transitions: HistoryTransition[] = [];
  const clock = { nowMs: NOW_MS };
  const deps = {
    lease: {
      acquireSessionLease: jest.fn(async (input: AcquireSessionLeaseInput) => {
        calls.push("acquire");
        return {
          kind: "admitted" as const,
          reservation: reservationFor(input),
        };
      }),
      startLeaseRenewal: jest.fn(
        (_reservation: SessionReservation, renewal: LeaseRenewalHooks) => {
          calls.push("renew");
          hooks = renewal;
        },
      ),
      releaseSessionLease: jest.fn(async () => {
        calls.push("release");
      }),
      latestLeaseCap: jest.fn((): number | undefined => undefined),
      confirmedLeaseExpiry: jest.fn((): number | undefined => CONFIRMED_UNTIL),
    },
    history: {
      transitionMeetingHistory: jest.fn(async (input: HistoryTransition) => {
        calls.push(`history:${input.expectedStatus}->${input.patch.status}`);
        transitions.push(input);
        return "applied" as const;
      }),
    },
    requestCaptureProtection: jest.fn(async () => {
      calls.push("protect");
    }),
    releaseCaptureProtection: jest.fn(() => {
      calls.push("unprotect");
    }),
    joinVoice: jest.fn<Promise<VoiceConnection>, Parameters<typeof joinVoice>>(
      async () => {
        calls.push("join");
        return connection;
      },
    ),
    leaveVoice: jest.fn(() => {
      calls.push("leave");
    }),
    dropVoiceLocally: jest.fn(() => {
      calls.push("drop");
    }),
    buildMeetingSession: jest.fn(
      async (
        _options: MeetingInitOptions,
        _reservation: unknown,
        _connection: VoiceConnection,
        _signal: AbortSignal,
        sessionHooks?: { onReceiving?(): void; ownershipSignal?: AbortSignal },
      ) => {
        calls.push("build");
        ownershipSignal = sessionHooks?.ownershipSignal;
        sessionHooks?.onReceiving?.();
        return meeting;
      },
    ),
    disposeFailedSession: jest.fn(async () => true),
    startDeadline: () => deadline.signal,
    captureEndHandlers: () => captureEnd,
    endMeeting: jest.fn(),
    indexMeeting: jest.fn(async () => undefined),
    nowMs: () => clock.nowMs,
  };
  const start = createMeetingStart(deps as unknown as MeetingStartDeps);
  return {
    deps,
    calls,
    deadline,
    clock,
    connection,
    meeting,
    transitions,
    hooks: () => hooks,
    ownershipSignal: () => ownershipSignal,
    captureEnd,
    start: (overrides?: Partial<MeetingInitOptions>) =>
      start.startMeetingSession(options(overrides)),
  };
}

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test("row is written with lifecycleVersion 2 before voice", async () => {
  const world = setup();

  await expect(world.start()).resolves.toBe(world.meeting);

  const input = world.deps.lease.acquireSessionLease.mock.calls[0][0];
  expect(input.sessionMode).toBe("meeting");
  if (input.sessionMode !== "meeting") throw new Error("Expected a meeting");
  expect(input.history).toMatchObject({
    guildId: GUILD,
    meetingId: MEETING,
    channelId_timestamp: `synthetic-voice#${new Date(NOW_MS).toISOString()}`,
  });
  expect(input.signal).toBeDefined();
  expect(world.calls.indexOf("acquire")).toBeLessThan(
    world.calls.indexOf("join"),
  );
  expect(world.calls.at(-1)).toBe("history:starting->in_progress");
});

test("renewal starts before protection is requested and before voice is joined", async () => {
  const world = setup();

  await world.start();

  expect(world.calls).toEqual([
    "acquire",
    "renew",
    "protect",
    "join",
    "build",
    "history:starting->in_progress",
  ]);
  expect(world.hooks()?.snapshot()).toEqual(
    expect.objectContaining({ status: "in_progress" }),
  );
});

test("join failure marks failed and releases", async () => {
  const world = setup();
  const failure = new Error("voice gateway refused");
  world.deps.joinVoice.mockRejectedValueOnce(failure);

  await expect(world.start()).rejects.toBe(failure);

  expect(world.deps.leaveVoice).not.toHaveBeenCalled();
  expect(world.deps.buildMeetingSession).not.toHaveBeenCalled();
  expect(world.transitions).toEqual([
    expect.objectContaining({
      expectedStatus: "starting",
      patch: expect.objectContaining({ status: "failed" }),
    }),
  ]);
  expect(world.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
  expect(world.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("a failure after the meeting reached in_progress fails the row from in_progress", async () => {
  const world = setup();
  world.deps.history.transitionMeetingHistory
    .mockImplementationOnce(async () => {
      throw new Error("write outcome unknown");
    })
    .mockResolvedValueOnce("stale")
    .mockResolvedValueOnce("applied");

  await expect(world.start()).rejects.toThrow("write outcome unknown");

  const statuses = world.deps.history.transitionMeetingHistory.mock.calls.map(
    ([input]) => input.expectedStatus,
  );
  expect(statuses).toEqual(["starting", "starting", "in_progress"]);
  expect(world.deps.leaveVoice).toHaveBeenCalledWith(world.connection);
  expect(world.deps.disposeFailedSession).toHaveBeenCalledTimes(1);
});

test("a failed start sends the voice leave before disposing the session", async () => {
  const world = setup();
  world.deps.disposeFailedSession.mockImplementationOnce(async () => {
    world.calls.push("dispose");
    return true;
  });
  world.deps.buildMeetingSession.mockRejectedValueOnce(new Error("build"));

  await expect(world.start()).rejects.toThrow("build");

  expect(world.calls.indexOf("leave")).toBeGreaterThan(-1);
  expect(world.calls.indexOf("leave")).toBeLessThan(
    world.calls.indexOf("dispose"),
  );
});

test.each(["the session build", "the in_progress write"] as const)(
  "a start that fails after capture began, at %s, retires the capture before the lease is released",
  async (step) => {
    const world = setup();
    const retire = jest.fn(() => {
      world.calls.push("retire");
    });
    const capture = { retire } as unknown as MeetingData["recordingCapture"];
    world.deps.buildMeetingSession.mockImplementationOnce(
      async (_options, _reservation, _connection, _signal, sessionHooks) => {
        world.calls.push("build");
        world.meeting.recordingCapture = capture;
        if (step === "the in_progress write") return world.meeting;
        Object.assign(
          (sessionHooks as { initialization: { meeting?: MeetingData } })
            .initialization,
          { meeting: world.meeting },
        );
        throw new Error("synthetic build failure");
      },
    );
    if (step === "the in_progress write")
      world.deps.history.transitionMeetingHistory.mockResolvedValueOnce(
        "stale",
      );

    await expect(world.start()).rejects.toThrow();

    expect(retire).toHaveBeenCalledTimes(1);
    expect(world.meeting.recordingCapture).toBeUndefined();
    expect(world.calls.indexOf("retire")).toBeLessThan(
      world.calls.indexOf("release"),
    );
  },
);

test("a deadline during the protection request sends no join", async () => {
  const world = setup();
  world.deps.requestCaptureProtection.mockImplementationOnce(async () => {
    world.deadline.abort(new Error("start deadline"));
  });

  await expect(world.start()).rejects.toThrow("start deadline");

  expect(world.deps.joinVoice).not.toHaveBeenCalled();
  expect(world.deps.leaveVoice).not.toHaveBeenCalled();
  expect(world.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("the start deadline aborts a join that never becomes ready, marks the row failed, sends a leave and releases the lease", async () => {
  const world = setup();
  const connection = world.connection;
  // As voiceSession.joinVoice does: a join that is not Ready is left, then the abort surfaces.
  world.deps.joinVoice.mockImplementationOnce(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<VoiceConnection>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          world.deps.leaveVoice(connection);
          reject(signal.reason);
        });
      }),
  );

  const started = world.start();
  await new Promise((resolve) => setImmediate(resolve));
  world.deadline.abort(new Error("start deadline"));

  await expect(started).rejects.toThrow("start deadline");
  expect(world.deps.leaveVoice).toHaveBeenCalledTimes(1);
  expect(world.transitions[0]).toMatchObject({
    expectedStatus: "starting",
    patch: { status: "failed" },
  });
  expect(world.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("the deadline no longer applies once audio is received", async () => {
  const world = setup();
  let signalAfterReceiving: AbortSignal | undefined;
  world.deps.buildMeetingSession.mockImplementationOnce(
    async (_o, _r, _c, signal, sessionHooks) => {
      sessionHooks?.onReceiving?.();
      world.deadline.abort(new Error("start deadline"));
      signalAfterReceiving = signal;
      return world.meeting;
    },
  );

  await expect(world.start()).resolves.toBe(world.meeting);
  expect(signalAfterReceiving?.aborted).toBe(false);
});

test("a blocked admission joins nothing and writes nothing", async () => {
  const world = setup();
  world.deps.lease.acquireSessionLease.mockResolvedValueOnce({
    kind: "blocked",
    reason: "active_session",
  } as never);

  await expect(world.start()).rejects.toThrow(
    "Voice session admission blocked: active_session",
  );

  expect(world.deps.lease.startLeaseRenewal).not.toHaveBeenCalled();
  expect(world.deps.requestCaptureProtection).not.toHaveBeenCalled();
  expect(world.deps.joinVoice).not.toHaveBeenCalled();
  expect(world.deps.history.transitionMeetingHistory).not.toHaveBeenCalled();
  expect(world.deps.lease.releaseSessionLease).not.toHaveBeenCalled();
});

test("a voice-only session requests no protection", async () => {
  const world = setup();

  await world.start({ sessionMode: "tts_only" });

  expect(world.deps.requestCaptureProtection).not.toHaveBeenCalled();
  expect(world.deps.joinVoice).toHaveBeenCalledWith(
    expect.objectContaining({ captureAudio: false }),
  );
  expect(world.deps.history.transitionMeetingHistory).not.toHaveBeenCalled();
});

test("protection stays while another lease is live", async () => {
  const world = setup();
  world.deps.joinVoice.mockRejectedValueOnce(new Error("refused"));
  world.deps.lease.latestLeaseCap.mockReturnValue(NOW_MS / 1000 + 60);

  await expect(world.start()).rejects.toThrow("refused");

  expect(world.deps.releaseCaptureProtection).not.toHaveBeenCalled();
});

test("a release that throws still rethrows the original failure", async () => {
  const world = setup();
  const failure = new Error("refused");
  world.deps.joinVoice.mockRejectedValueOnce(failure);
  world.deps.lease.releaseSessionLease.mockRejectedValueOnce(
    new Error("release unknown"),
  );

  await expect(world.start()).rejects.toBe(failure);
  expect(world.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("a stop request during the start is applied once the meeting exists", async () => {
  const world = setup();
  const onEndMeeting = jest.fn();
  Object.assign(world.meeting, { onEndMeeting });
  world.deps.joinVoice.mockImplementationOnce(async () => {
    world.hooks()?.onEndRequested({
      endRequestedAt: "2026-11-11T00:00:00.000Z",
      endRequestedByUserId: "synthetic-user",
    } as ActiveMeetingLease);
    return world.connection;
  });

  await world.start();

  expect(world.deps.endMeeting).toHaveBeenCalledWith(world.meeting);
  expect(world.meeting.endTriggeredByUserId).toBe("synthetic-user");
  expect(world.meeting.endReason).toBe("web_ui");
});

test.each([
  [true, true],
  [false, undefined],
] as const)(
  "a dismissal during the start cancels only an auto-recording (auto-recording: %s)",
  async (isAutoRecording, cancelled) => {
    const world = setup();
    Object.assign(world.meeting, { onEndMeeting: jest.fn(), isAutoRecording });
    world.deps.joinVoice.mockImplementationOnce(async () => {
      world.hooks()?.onEndRequested({
        endRequestedAt: "2026-11-11T00:00:00.000Z",
        endRequestedByUserId: "synthetic-user",
        endReason: "dismissed",
      } as ActiveMeetingLease);
      return world.connection;
    });

    await world.start();

    expect(world.meeting.endReason).toBe("dismissed");
    expect(world.meeting.cancelled).toBe(cancelled);
    if (cancelled)
      expect(world.meeting.cancellationReason).toBe(
        "Stopped by <@synthetic-user>",
      );
  },
);

test("the row written at start carries the fields the terminal save assumes", async () => {
  const world = setup();

  await world.start({
    isAutoRecording: true,
    startReason: "auto_record_channel",
    startTriggeredByUserId: "synthetic-trigger",
    autoRecordRule: { mode: "channel", channelId: "synthetic-voice" },
    meetingContext: "synthetic context",
    tags: ["synthetic"],
  });

  const input = world.deps.lease.acquireSessionLease.mock.calls[0][0];
  if (input.sessionMode !== "meeting") throw new Error("Expected a meeting");
  expect(input.history).toMatchObject({
    textChannelId: "synthetic-text",
    channelId: "synthetic-voice",
    meetingCreatorId: "synthetic-user",
    isAutoRecording: true,
    autoRecordRule: { mode: "channel", channelId: "synthetic-voice" },
    startReason: "auto_record_channel",
    startTriggeredByUserId: "synthetic-trigger",
    transcribeMeeting: true,
    generateNotes: true,
    context: "synthetic context",
    tags: ["synthetic"],
    participants: [],
    duration: 0,
  });
});

test("the user index is written for a meeting that later fails", async () => {
  const world = setup();
  Object.assign(world.meeting, {
    participants: new Map([["synthetic-member", { id: "synthetic-member" }]]),
  });

  await world.start();

  expect(world.deps.indexMeeting).toHaveBeenCalledWith(
    expect.objectContaining({
      meetingId: MEETING,
      meetingCreatorId: "synthetic-user",
      participants: [{ id: "synthetic-member" }],
    }),
  );
});

test("a voice-only session writes no user index", async () => {
  const world = setup();

  await world.start({ sessionMode: "tts_only" });

  expect(world.deps.indexMeeting).not.toHaveBeenCalled();
});

test("a lost lease aborts the capture signal before the lost handler runs", async () => {
  const world = setup();
  await world.start();
  const signal = world.ownershipSignal();
  expect(signal?.aborted).toBe(false);
  world.captureEnd.onLost.mockImplementationOnce(() => {
    expect(signal?.aborted).toBe(true);
  });

  world.hooks()?.onLost();

  expect(world.captureEnd.onLost).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(true);
});

test("a capped lease leaves the capture signal live", async () => {
  const world = setup();
  await world.start();

  world.hooks()?.onCapReached();

  expect(world.ownershipSignal()?.aborted).toBe(false);
});

describe("a start whose lease another meeting took does nothing visible", () => {
  test("a start that fails after the lease was lost drops the connection locally and sends no leave", async () => {
    const world = setup();
    world.deps.buildMeetingSession.mockImplementationOnce(async () => {
      world.hooks()?.onLost();
      throw new Error("synthetic build failure");
    });

    await expect(world.start()).rejects.toThrow("synthetic build failure");

    expect(world.deps.dropVoiceLocally).toHaveBeenCalledWith(world.connection);
    expect(world.deps.leaveVoice).not.toHaveBeenCalled();
  });

  test("a start that fails for another reason still leaves", async () => {
    const world = setup();
    world.deps.buildMeetingSession.mockRejectedValueOnce(
      new Error("synthetic build failure"),
    );

    await expect(world.start()).rejects.toThrow("synthetic build failure");

    expect(world.deps.leaveVoice).toHaveBeenCalledWith(world.connection);
    expect(world.deps.dropVoiceLocally).not.toHaveBeenCalled();
  });

  test("a start whose lease is lost before the join does not join", async () => {
    const world = setup();
    world.deps.requestCaptureProtection.mockImplementationOnce(async () => {
      world.hooks()?.onLost();
    });

    await expect(world.start()).rejects.toThrow(
      "Meeting lease lost to another meeting",
    );

    expect(world.deps.joinVoice).not.toHaveBeenCalled();
    expect(world.deps.leaveVoice).not.toHaveBeenCalled();
    expect(world.deps.dropVoiceLocally).not.toHaveBeenCalled();
  });

  test("a start that fails after its confirmed lease lapsed, before any loss is reported, drops the connection locally", async () => {
    const world = setup();
    world.deps.buildMeetingSession.mockImplementationOnce(async () => {
      world.clock.nowMs = (CONFIRMED_UNTIL + 1) * MS_PER_SECOND;
      throw new Error("synthetic build failure");
    });

    await expect(world.start()).rejects.toThrow("synthetic build failure");

    expect(world.deps.dropVoiceLocally).toHaveBeenCalledWith(world.connection);
    expect(world.deps.leaveVoice).not.toHaveBeenCalled();
  });
});

describe("a pending join that fails sends a leave only while the lease is confirmed", () => {
  /** The real join over a gateway that records payloads: a `null` channel is a leave. */
  async function pendingRealJoin() {
    const world = setup();
    const voice = fakeVoiceGuild();
    world.deps.joinVoice.mockImplementationOnce(joinVoice);
    const started = world.start({ guild: voice.guild as never });
    started.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(voice.channelIds()).toEqual(["synthetic-voice"]);
    return { world, started, voice };
  }

  test("a lease lost while the join is pending ends the join at once and sends no leave", async () => {
    const { world, started, voice } = await pendingRealJoin();

    world.hooks()?.onLost();

    await expect(started).rejects.toThrow();
    expect(world.deadline.signal.aborted).toBe(false);
    expect(voice.channelIds()).toEqual(["synthetic-voice"]);
    expect(getVoiceConnection(voice.guild.id)).toBeUndefined();
    expect(world.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
  });

  test("a deadline that fires after a stall past the confirmed lease sends no leave", async () => {
    const { world, started, voice } = await pendingRealJoin();

    world.clock.nowMs = (CONFIRMED_UNTIL + 1) * MS_PER_SECOND;
    world.deadline.abort(new Error("start deadline"));

    await expect(started).rejects.toThrow();
    expect(voice.channelIds()).toEqual(["synthetic-voice"]);
    expect(getVoiceConnection(voice.guild.id)).toBeUndefined();
  });

  test("a deadline inside the confirmed lease sends the leave", async () => {
    const { world, started, voice } = await pendingRealJoin();

    world.clock.nowMs = CONFIRMED_UNTIL * MS_PER_SECOND;
    world.deadline.abort(new Error("start deadline"));

    await expect(started).rejects.toThrow();
    expect(voice.channelIds()).toEqual(["synthetic-voice", null]);
  });
});
