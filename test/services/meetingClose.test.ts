/** @jest-environment node */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import type { VoiceConnection } from "@discordjs/voice";
import { createMockMeetingLeaseRepository } from "../../src/repositories/meetingLeaseRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { createMeetingLeaseService } from "../../src/services/meetingLease";
import type { ActiveMeetingLease } from "../../src/types/db";
import { historyRow } from "../repositories/meetingLeaseRepository.contract";
import {
  createMeetingClose,
  flushCapture,
  retireCapture,
  type MeetingCloseDeps,
} from "../../src/services/meetingClose";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecordingCheckpointCapture } from "../../src/services/recordingCheckpointCapture";
import { performance } from "node:perf_hooks";
import {
  freezeCompletionPolicy,
  stopCompletionClock,
} from "../../src/services/meetingCompletionPolicyService";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SessionReservation } from "../../src/types/meetingHistoryTransition";

const GUILD = "synthetic-guild";
const NOW_MS = 1_800_000_000_000;
const START_MS = NOW_MS - 90_000;
const INSTANCE = "synthetic-instance";

function reservationFor(
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

function meetingFor(
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

const never = () => new Promise<never>(() => undefined);

type D = MeetingCloseDeps;

function setup(live: MeetingData[] = [], overrides: Partial<D> = {}) {
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

const button = { endReason: "button" as const, endTriggeredByUserId: "u-1" };

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test("a normal close leaves voice, restores the nickname, writes processing with a claim, releases the lease and starts the local finish, in that order", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, button);

  expect(t.calls).toEqual([
    "confirm",
    "stop:complete",
    "leave",
    "nickname",
    "flush",
    "record",
    "retire",
    "release",
    "drop",
    "unprotect",
    "prepare",
    "finish",
  ]);
  const [input] = t.recorded();
  expect(input.reservation).toBe(meeting.reservation);
  expect(input.patch).toEqual({
    capture: expect.objectContaining({ kind: "complete" }),
    endReason: "button",
    endTriggeredByUserId: "u-1",
    duration: (NOW_MS - START_MS) / 1000,
  });
  expect(input.claimOwner).toMatch(new RegExp(`^${INSTANCE}:[0-9a-f-]{36}$`));
  expect(input.now).toBe(NOW_MS / 1000);
  expect(t.starter).toHaveBeenCalledWith(meeting, input.claimOwner);
  expect(t.deps.leaveVoice).toHaveBeenCalledWith(meeting.connection);
  expect(meeting.finishing).toBe(true);
});

test("step 4 is retried", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.finish.recordCaptureEnd
    .mockRejectedValueOnce(new Error("synthetic outage"))
    .mockRejectedValueOnce(new Error("synthetic outage"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(
    LIFECYCLE.closeWriteAttempts,
  );
  const owners = t.recorded().map((input) => input.claimOwner);
  expect(new Set(owners).size).toBe(1);
  expect(t.starter).toHaveBeenCalledTimes(1);
});

test("step 4 that never succeeds still frees the server and starts no local finish", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.finish.recordCaptureEnd.mockRejectedValue(new Error("synthetic"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(
    LIFECYCLE.closeWriteAttempts,
  );
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.starter).not.toHaveBeenCalled();
});

test("lease is released when step 3 throws", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.flushCapture.mockRejectedValueOnce(new Error("synthetic flush"));

  await expect(t.close.closeMeeting(meeting, button)).resolves.toBeUndefined();

  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledWith(
    meeting.reservation,
  );
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("a release that throws still drops the meeting and releases protection", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.releaseSessionLease.mockRejectedValueOnce(new Error("unknown"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("draining worker writes no claim", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.isEligible.mockReturnValue(false);

  await t.close.closeMeeting(meeting, button);

  expect(t.recorded()[0].claimOwner).toBeUndefined();
  expect(t.recorded()[0].patch.capture?.kind).toBe("complete");
  expect(t.starter).not.toHaveBeenCalled();
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

function hangFlush(t: ReturnType<typeof setup>) {
  t.deps.flushCapture.mockImplementationOnce(() => never());
  t.deps.sleep.mockImplementation((ms: number) =>
    ms === LIFECYCLE.closeFlushMs ? Promise.resolve() : never(),
  );
}

describe.each([
  { flush: "times out", fail: (t: ReturnType<typeof setup>) => hangFlush(t) },
  {
    flush: "reports a partial save",
    fail: (t: ReturnType<typeof setup>) =>
      t.deps.flushCapture.mockResolvedValueOnce(false),
  },
  {
    flush: "throws",
    fail: (t: ReturnType<typeof setup>) =>
      t.deps.flushCapture.mockRejectedValueOnce(new Error("synthetic flush")),
  },
])("a flush that $flush", ({ fail }) => {
  test("with no finish claim records the capture as interrupted", async () => {
    const meeting = meetingFor();
    const t = setup([meeting]);
    t.deps.isEligible.mockReturnValue(false);
    fail(t);

    await t.close.closeMeeting(meeting, button);

    const [input] = t.recorded();
    expect(input.claimOwner).toBeUndefined();
    expect(input.patch.capture).toEqual({
      kind: "interrupted",
      startedAt: new Date(START_MS).toISOString(),
      endedAt: new Date(NOW_MS).toISOString(),
      detectedAt: new Date(NOW_MS).toISOString(),
    });
    expect(input.patch.endReason).toBe("button");
  });

  test("with a finish claim still records the capture as complete", async () => {
    const meeting = meetingFor();
    const t = setup([meeting]);
    fail(t);

    await t.close.closeMeeting(meeting, button);

    const [input] = t.recorded();
    expect(input.claimOwner).toEqual(expect.any(String));
    expect(input.patch.capture?.kind).toBe("complete");
    expect(t.starter).toHaveBeenCalledTimes(1);
  });
});

test("a dismissed short auto-recording whose flush failed with no claim keeps its cancel decision", async () => {
  const meeting = autoRecording(meetingFor(), "Stopped by synthetic user");
  const t = setup([meeting], {
    stopCapture: (stopped) => {
      stopCompletionClock(stopped);
      stopped.recordingCaptureState = {
        kind: "complete",
        startedAt: new Date(START_MS).toISOString(),
        endedAt: new Date(NOW_MS).toISOString(),
      };
    },
  });
  t.deps.isEligible.mockReturnValue(false);
  t.deps.flushCapture.mockResolvedValueOnce(false);

  await t.close.closeMeeting(meeting, {
    endReason: "dismissed",
    endTriggeredByUserId: "u-1",
  });

  const [input] = t.recorded();
  expect(input.patch.capture?.kind).toBe("interrupted");
  expect(input.patch.completionPolicy?.decision).toBe("cancel");
  expect(input.patch.cancellationReason).toBe("Stopped by synthetic user");
});

test("a flush that completes on a close with no finish claim records the capture as complete", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.isShuttingDown.mockReturnValue(true);

  await t.close.closeMeeting(meeting, button);

  expect(t.recorded()[0].claimOwner).toBeUndefined();
  expect(t.recorded()[0].patch.capture?.kind).toBe("complete");
});

test("a shutting-down worker writes no claim and starts no local finish", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.isShuttingDown.mockReturnValue(true);

  await t.close.closeMeeting(meeting, {
    endReason: "unknown",
    abnormal: true,
  });

  expect(t.recorded()[0].claimOwner).toBeUndefined();
  expect(t.recorded()[0].patch.capture?.kind).toBe("interrupted");
  expect(t.starter).not.toHaveBeenCalled();
  expect(t.deps.prepareLocalFinish).not.toHaveBeenCalled();
});

test("a close with no local finish ends the encoder, within its bound", async () => {
  const meeting = meetingFor();
  const sleep = jest.fn<D["sleep"]>(async () => undefined);
  const t = setup([meeting], { sleep });
  t.deps.isEligible.mockReturnValue(false);
  t.deps.endEncoder.mockImplementation(() => {
    t.calls.push("end-encoder");
    return never();
  });

  await t.close.closeMeeting(meeting, button);

  expect(t.calls.indexOf("end-encoder")).toBeGreaterThan(
    t.calls.indexOf("retire"),
  );
  expect(sleep).toHaveBeenCalledWith(
    LIFECYCLE.closeEncoderMs,
    expect.anything(),
  );
  expect(t.starter).not.toHaveBeenCalled();
});

test("a close that starts a local finish leaves the encoder to the loader", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, button);
  await new Promise((resolve) => setImmediate(resolve));

  expect(t.starter).toHaveBeenCalledTimes(1);
  expect(t.deps.endEncoder).not.toHaveBeenCalled();
});

test("a local finish that refuses the meeting hands the encoder back to close", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.starter.mockResolvedValue(false);

  await t.close.closeMeeting(meeting, button);
  await new Promise((resolve) => setImmediate(resolve));

  expect(t.deps.endEncoder).toHaveBeenCalledWith(meeting);
});

test("a close at shutdown flushes within the shutdown bound, writes once, and ends inside its deadline", async () => {
  const meeting = meetingFor();
  const bounds: number[] = [];
  const sleep = jest.fn<D["sleep"]>(async (ms) => {
    bounds.push(ms);
  });
  const t = setup([meeting], { sleep });
  t.deps.isShuttingDown.mockReturnValue(true);
  t.deps.flushCapture.mockImplementation(() => never());
  t.deps.finish.recordCaptureEnd.mockRejectedValue(new Error("synthetic"));
  // Leaves just enough after the flush for one write, the lease release and the encoder.
  const afterFlush = 2 * LIFECYCLE.leaseHeartbeatMs + LIFECYCLE.closeEncoderMs;
  const deadlineMs = NOW_MS + afterFlush + 7_000;

  await t.close.closeMeeting(meeting, {
    endReason: "unknown",
    abnormal: true,
    deadlineMs,
  });

  expect(bounds).toContain(7_000);
  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
});

test("a close while shutting down without a deadline flushes within the shutdown bound", async () => {
  const meeting = meetingFor();
  const bounds: number[] = [];
  const sleep = jest.fn<D["sleep"]>(async (ms) => {
    bounds.push(ms);
  });
  const t = setup([meeting], { sleep });
  t.deps.isShuttingDown.mockReturnValue(true);
  t.deps.flushCapture.mockImplementation(() => never());

  await t.close.closeMeeting(meeting, button);

  expect(bounds).toContain(LIFECYCLE.shutdownFlushMs);
  expect(bounds).not.toContain(LIFECYCLE.closeFlushMs);
});

test.each(["rejects", "throws"] as const)(
  "a local finish starter that %s is logged and close ends the encoder",
  async (failure) => {
    const meeting = meetingFor();
    const t = setup([meeting]);
    const error = new Error("synthetic starter failure");
    if (failure === "rejects") t.starter.mockRejectedValue(error);
    else
      t.starter.mockImplementation(() => {
        throw error;
      });

    await t.close.closeMeeting(meeting, button);
    await new Promise((resolve) => setImmediate(resolve));

    expect(t.deps.endEncoder).toHaveBeenCalledWith(meeting);
    expect(console.error).toHaveBeenCalledWith(
      "Local meeting finish failed to start",
      expect.objectContaining({ meetingId: meeting.meetingId }),
    );
  },
);

test("lost lease sends no leave and writes interrupted", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockResolvedValueOnce("lost");

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).not.toHaveBeenCalled();
  expect(t.deps.dropVoiceLocally).toHaveBeenCalledWith(meeting.connection);
  expect(t.deps.restoreNickname).not.toHaveBeenCalled();
  expect(t.deps.flushCapture).not.toHaveBeenCalled();
  const [input] = t.recorded();
  expect(input.claimOwner).toBeUndefined();
  expect(input.patch.capture?.kind).toBe("interrupted");
  expect(input.patch.endReason).toBe("unknown");
  expect(input.patch.endTriggeredByUserId).toBeUndefined();
  expect(t.deps.lease.releaseSessionLease).not.toHaveBeenCalled();
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.starter).not.toHaveBeenCalled();
});

test("an abnormal cause or an already interrupted capture writes interrupted", async () => {
  const abnormal = meetingFor("synthetic-meeting-a");
  const failed = meetingFor("synthetic-meeting-b");
  failed.recordingCaptureState = {
    kind: "interrupted",
    startedAt: null,
    endedAt: null,
    detectedAt: new Date(NOW_MS).toISOString(),
  };
  const t = setup([abnormal, failed]);

  await t.close.closeMeeting(abnormal, {
    endReason: "unknown",
    abnormal: true,
  });
  await t.close.closeMeeting(failed, button);

  expect(t.recorded().map((input) => input.patch.capture?.kind)).toEqual([
    "interrupted",
    "interrupted",
  ]);
  expect(t.deps.leaveVoice).toHaveBeenCalledTimes(2);
});

test("concurrent closes share one promise and write the capture end once", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);

  const first = t.close.closeMeeting(meeting, button);
  const second = t.close.closeMeeting(meeting, {
    endReason: "channel_empty",
  });
  expect(second).toBe(first);
  await Promise.all([first, second]);

  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.recorded()[0].patch.endReason).toBe("button");
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("a capture that reached its lease cap closes normally with a leave", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockResolvedValueOnce("capped");

  await t.close.closeMeeting(meeting, { endReason: "timeout" });

  expect(t.deps.leaveVoice).toHaveBeenCalledWith(meeting.connection);
  expect(t.deps.dropVoiceLocally).not.toHaveBeenCalled();
  expect(t.recorded()[0].patch).toMatchObject({
    capture: { kind: "complete" },
    endReason: "timeout",
  });
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("a confirmation error before this worker's lease ran out closes normally", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockRejectedValueOnce(new Error("outage"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).toHaveBeenCalledTimes(1);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("protection is released only when the last capture closes", async () => {
  const first = meetingFor("synthetic-meeting-a");
  const second = meetingFor("synthetic-meeting-b");
  const t = setup([first, second]);
  t.setCap(NOW_MS / 1000 + 600);

  await t.close.closeMeeting(first, button);
  expect(t.deps.releaseCaptureProtection).not.toHaveBeenCalled();

  t.setCap(undefined);
  await t.close.closeMeeting(second, button);
  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("a voice-only session leaves voice and releases the lease without writing a row", async () => {
  const meeting = meetingFor("synthetic-tts", "tts_only");
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, { endReason: "leave_command" });

  expect(t.calls).toEqual([
    "confirm",
    "stop:complete",
    "leave",
    "nickname",
    "retire",
    "release",
    "drop",
  ]);
  expect(t.deps.finish.recordCaptureEnd).not.toHaveBeenCalled();
  expect(t.deps.releaseCaptureProtection).not.toHaveBeenCalled();
  expect(t.starter).not.toHaveBeenCalled();
});

test("a flush that exceeds the bound does not prevent the lease from being released", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.flushCapture.mockImplementationOnce(() => never());
  t.deps.sleep.mockImplementation((ms: number) =>
    ms === LIFECYCLE.closeFlushMs ? Promise.resolve() : never(),
  );

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.sleep).toHaveBeenCalledWith(
    LIFECYCLE.closeFlushMs,
    expect.any(AbortSignal),
  );
  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
});

test("closeAllCaptures never rejects and returns within the shutdown budget", async () => {
  const stuck = meetingFor("synthetic-meeting-a");
  const failing = meetingFor("synthetic-meeting-b");
  const t = setup([stuck, failing]);
  t.deps.flushCapture.mockImplementation((meeting: MeetingData) =>
    meeting === stuck ? never() : Promise.resolve(true),
  );
  t.deps.leaveVoice.mockImplementation((connection: VoiceConnection) => {
    if (connection === failing.connection) throw new Error("synthetic leave");
  });
  const budget = LIFECYCLE.shutdownBudgetMs - LIFECYCLE.shutdownReserveMs;
  t.deps.sleep.mockImplementation((ms: number) =>
    ms === budget ? Promise.resolve() : never(),
  );

  await expect(
    t.close.closeAllCaptures({ endReason: "unknown", abnormal: true }),
  ).resolves.toBeUndefined();

  expect(t.deps.sleep).toHaveBeenCalledWith(budget, expect.any(AbortSignal));
  // The same promise closeAllCaptures started; the stuck capture never settles.
  await t.close.closeMeeting(failing, button);
  expect(t.deps.restoreNickname).toHaveBeenCalledWith(failing);
  expect(t.deps.flushCapture).toHaveBeenCalledWith(failing);
  expect(t.recorded().map((input) => input.reservation)).toEqual([
    failing.reservation,
  ]);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledWith(
    failing.reservation,
  );
});

test("closeAllCaptures skips meetings it does not hold", async () => {
  const ours = meetingFor("synthetic-meeting-a");
  const legacy = meetingFor("synthetic-meeting-b");
  const t = setup([ours, legacy]);
  t.deps.lease.holdsSessionLease.mockImplementation(
    (reservation) => reservation.meetingId === ours.meetingId,
  );

  await t.close.closeAllCaptures({ endReason: "unknown", abnormal: true });

  expect(t.deps.lease.confirmSessionLease).toHaveBeenCalledTimes(1);
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(ours);
  expect(t.deps.dropMeeting).not.toHaveBeenCalledWith(legacy);
  expect(t.deps.leaveVoice).not.toHaveBeenCalledWith(legacy.connection);
  expect(legacy.finishing).toBe(false);
});

test("close refuses a meeting the new lease service does not hold and changes nothing", async () => {
  const legacy = meetingFor();
  const ending = meetingFor("synthetic-meeting-b");
  ending.finishing = true;
  const t = setup([legacy, ending]);
  t.deps.lease.holdsSessionLease.mockImplementation(
    (reservation) => reservation.meetingId !== legacy.meetingId,
  );

  await t.close.closeMeeting(legacy, button);
  await t.close.closeMeeting(ending, button);

  expect(t.calls).toEqual([]);
  expect(legacy.finishing).toBe(false);
  expect(legacy.endReason).toBeUndefined();
  expect(t.deps.liveMeetings()).toEqual([legacy, ending]);
});

test("a nickname restore that never resolves does not delay the lease release beyond its bound", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.restoreNickname.mockImplementationOnce(() => never());
  t.deps.sleep.mockImplementation((ms: number) =>
    ms === LIFECYCLE.closeNicknameMs ? Promise.resolve() : never(),
  );

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.sleep).toHaveBeenCalledWith(
    LIFECYCLE.closeNicknameMs,
    expect.any(AbortSignal),
  );
  expect(t.deps.flushCapture).toHaveBeenCalledTimes(1);
  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("a step-2 failure does not skip the steps after it", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.stopCapture.mockImplementationOnce(() => {
    throw new Error("synthetic stop");
  });
  t.deps.leaveVoice.mockImplementationOnce(() => {
    throw new Error("synthetic leave");
  });

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).toHaveBeenCalledWith(meeting.connection);
  expect(t.calls).toEqual([
    "confirm",
    "nickname",
    "flush",
    "record",
    "retire",
    "release",
    "drop",
    "unprotect",
    "prepare",
    "finish",
  ]);
});

test("a confirmation error after this worker's lease ran out drops voice locally", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockRejectedValueOnce(new Error("outage"));
  t.deps.lease.confirmedLeaseExpiry.mockReturnValue(NOW_MS / 1000 - 1);

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).not.toHaveBeenCalled();
  expect(t.deps.dropVoiceLocally).toHaveBeenCalledWith(meeting.connection);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("a live voice-only session does not keep protection on after the last recording closes", async () => {
  const lease = createMeetingLeaseService({
    repository: createMockMeetingLeaseRepository(
      new Map<string, ActiveMeetingLease>(),
      new Map(),
      new Map(),
    ),
    instanceId: () => INSTANCE,
    nowMs: () => NOW_MS,
    schedule: () => () => undefined,
  });
  async function admit(
    guildId: string,
    meetingId: string,
    sessionMode: "meeting" | "tts_only",
  ) {
    const shared = {
      guildId,
      meetingId,
      voiceChannelId: "synthetic-voice",
      textChannelId: "synthetic-text",
      isAutoRecording: false,
      reservedAt: START_MS,
    };
    const admission = await lease.acquireSessionLease(
      sessionMode === "meeting"
        ? {
            ...shared,
            sessionMode,
            history: {
              ...historyRow(meetingId),
              guildId,
              channelId_timestamp: `synthetic-voice#${meetingId}`,
            },
          }
        : { ...shared, sessionMode },
    );
    if (admission.kind !== "admitted") throw new Error("Expected admission");
    lease.startLeaseRenewal(admission.reservation, {
      maxDurationMs: 60 * 60_000,
      snapshot: () => ({ status: "in_progress" }),
      onEndRequested: () => undefined,
      onLost: () => undefined,
      onCapReached: () => undefined,
    });
    const meeting = meetingFor(meetingId, sessionMode);
    Object.assign(meeting, { reservation: admission.reservation });
    return meeting;
  }
  const recording = await admit(
    "synthetic-guild-a",
    "synthetic-meeting-a",
    "meeting",
  );
  await admit("synthetic-guild-b", "synthetic-tts", "tts_only");
  const t = setup([recording], { lease });

  await t.close.closeMeeting(recording, button);

  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("lease loss and the cap close the live meeting", async () => {
  const lost = meetingFor("synthetic-meeting-a");
  const capped = meetingFor("synthetic-meeting-b");
  const t = setup([lost, capped]);

  t.close.captureEndHandlers.onLost({
    reservation: reservationFor("synthetic-meeting-a"),
    meeting: lost,
  });
  t.close.captureEndHandlers.onCapReached({
    reservation: reservationFor("synthetic-meeting-b"),
    meeting: capped,
  });
  t.close.captureEndHandlers.onLost({
    reservation: reservationFor("synthetic-meeting-c"),
  });
  await Promise.all([
    t.close.closeMeeting(lost, button),
    t.close.closeMeeting(capped, button),
  ]);

  expect(t.recorded().map((input) => input.patch.endReason)).toEqual([
    "unknown",
    "timeout",
  ]);
  expect(t.recorded()[0].patch.capture?.kind).toBe("interrupted");
  expect(t.recorded()[1].patch.capture?.kind).toBe("complete");
});

test("a normal close leaves the capture signal live", async () => {
  const meeting = meetingFor();
  const ownership = new AbortController();
  meeting.ownershipSignal = ownership.signal;
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, button);

  expect(meeting.ownershipSignal.aborted).toBe(false);
});

function autoRecording(meeting: MeetingData, cancellationReason?: string) {
  Object.assign(meeting, {
    isAutoRecording: true,
    chatLog: [],
    cancellationReason,
    runtimeConfig: { autoRecordCancellation: { enabled: true } },
  });
  if (meeting.reservation)
    meeting.reservation.timingReceipt = {
      reservedAt: START_MS,
      monotonicMilliseconds: performance.now(),
    };
  freezeCompletionPolicy(meeting);
  return meeting;
}

test("a dismissed short auto-recording writes the cancel decision with the capture end", async () => {
  const meeting = autoRecording(meetingFor(), "Stopped by synthetic user");
  const t = setup([meeting], {
    stopCapture: (stopped) => stopCompletionClock(stopped),
  });

  await t.close.closeMeeting(meeting, {
    endReason: "dismissed",
    endTriggeredByUserId: "u-1",
  });

  const [input] = t.recorded();
  expect(input.patch.completionPolicy).toMatchObject({
    isAutoRecording: true,
    dismissed: true,
    chatMessageCount: 0,
    decision: "cancel",
  });
  expect(input.patch.cancellationReason).toBe("Stopped by synthetic user");
});

test("a manual recording writes the proceed decision with the capture end", async () => {
  const meeting = autoRecording(meetingFor());
  meeting.isAutoRecording = false;
  const t = setup([meeting], {
    stopCapture: (stopped) => stopCompletionClock(stopped),
  });

  await t.close.closeMeeting(meeting, button);

  const [input] = t.recorded();
  expect(input.patch.completionPolicy?.decision).toBe("proceed");
  expect(input.patch.cancellationReason).toBeUndefined();
});

test("a lost lease writes the completion snapshot without a decision", async () => {
  const meeting = autoRecording(meetingFor(), "Stopped by synthetic user");
  const t = setup([meeting], {
    stopCapture: (stopped) => stopCompletionClock(stopped),
  });
  t.deps.lease.confirmSessionLease.mockResolvedValueOnce("lost");

  await t.close.closeMeeting(meeting, {
    endReason: "dismissed",
    endTriggeredByUserId: "u-1",
  });

  const [input] = t.recorded();
  expect(input.patch.completionPolicy?.decision).toBe("undecided");
  expect(input.patch.cancellationReason).toBeUndefined();
});

test("a voice-only session ends through close and frees the server", async () => {
  const meeting = meetingFor("synthetic-tts", "tts_only");
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, { endReason: "channel_empty" });

  expect(t.calls).toEqual([
    "confirm",
    "stop:complete",
    "leave",
    "nickname",
    "retire",
    "release",
    "drop",
  ]);
  expect(t.deps.finish.recordCaptureEnd).not.toHaveBeenCalled();
  expect(t.deps.releaseCaptureProtection).not.toHaveBeenCalled();
  expect(t.starter).not.toHaveBeenCalled();
});

test("stop pressed twice, or racing an emptied channel, closes once", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);

  const first = t.close.closeMeeting(meeting, button);
  const second = t.close.closeMeeting(meeting, { endReason: "channel_empty" });

  expect(second).toBe(first);
  await first;
  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.recorded()[0].patch).toMatchObject({
    endReason: "button",
    endTriggeredByUserId: "u-1",
  });
});

test.each([
  { path: "normal", cause: button, confirm: "held", flushHangs: false },
  {
    path: "capped",
    cause: { endReason: "timeout" as const },
    confirm: "capped",
    flushHangs: false,
  },
  {
    path: "abnormal",
    cause: { endReason: "unknown" as const, abnormal: true },
    confirm: "held",
    flushHangs: false,
  },
  { path: "lost", cause: button, confirm: "lost", flushHangs: false },
  { path: "flush timeout", cause: button, confirm: "held", flushHangs: true },
] as const)(
  "close retires the capture on every path: $path",
  async ({ cause, confirm, flushHangs, path }) => {
    const meeting = meetingFor();
    const t = setup([meeting]);
    t.deps.lease.confirmSessionLease.mockImplementationOnce(async () => {
      t.calls.push("confirm");
      return confirm;
    });
    if (flushHangs) {
      t.deps.flushCapture.mockImplementationOnce(() => never());
      t.deps.sleep.mockImplementation((ms: number) =>
        ms === LIFECYCLE.closeFlushMs ? Promise.resolve() : never(),
      );
    }

    await t.close.closeMeeting(meeting, cause);

    const lost = path === "lost";
    expect(t.deps.retireCapture).toHaveBeenCalledTimes(1);
    expect(t.deps.retireCapture).toHaveBeenCalledWith(meeting, lost);
    const retired = t.calls.indexOf(lost ? "retire:lost" : "retire");
    expect(retired).toBeGreaterThan(t.calls.indexOf("record"));
    expect(retired).toBeLessThan(t.calls.indexOf("drop"));
    if (!lost) expect(retired).toBeLessThan(t.calls.indexOf("release"));
  },
);

test("close marks the meeting finishing before its first await", () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockImplementationOnce(() => never());

  void t.close.closeMeeting(meeting, button);

  expect(meeting.finishing).toBe(true);
});

// A transcription completing after close is covered end to end by the lifecycle scenario
// "a recording with speech closes and finishes through the normal loader, and no capture failure follows".
test("a piece still unsaved at close never reports a capture failure once the capture is retired", async () => {
  jest.useFakeTimers({ now: NOW_MS });
  const directory = mkdtempSync(path.join(tmpdir(), "close-retire-"));
  try {
    const meeting = meetingFor();
    const ownership = new AbortController();
    meeting.ownershipSignal = ownership.signal;
    // Publication after close fails the lease condition; a stuck piece is what trips the unsaved timer.
    const commit = jest.fn(
      (_artifacts: unknown, signal: AbortSignal) =>
        new Promise<boolean>((resolve) =>
          signal.addEventListener("abort", () => resolve(false), {
            once: true,
          }),
        ),
    );
    const captureFailure = jest.fn();
    const capture = createRecordingCheckpointCapture({
      directory,
      startedAt: START_MS,
      signal: ownership.signal,
      commit,
      stopCapture: captureFailure,
    });
    meeting.recordingCapture = capture;
    capture.push("user:synthetic", Buffer.alloc(3840, 1), NOW_MS);
    const t = setup([meeting], { retireCapture });

    await t.close.closeMeeting(meeting, button);
    const committed = commit.mock.calls.length;
    await jest.advanceTimersByTimeAsync(120_000);

    expect(meeting.recordingCapture).toBeUndefined();
    expect(commit).toHaveBeenCalledTimes(committed);
    expect(captureFailure).not.toHaveBeenCalled();
    expect(ownership.signal.aborted).toBe(false);
  } finally {
    jest.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a loss close discovers retires the capture before aborting its signal, so no failure is reported", async () => {
  const meeting = meetingFor();
  const ownership = new AbortController();
  meeting.ownershipSignal = ownership.signal;
  meeting.abortOwnership = (reason) => ownership.abort(reason);
  const captureFailure = jest.fn();
  const directory = mkdtempSync(path.join(tmpdir(), "close-retire-"));
  try {
    meeting.recordingCapture = createRecordingCheckpointCapture({
      directory,
      startedAt: START_MS,
      signal: ownership.signal,
      commit: async () => true,
      stopCapture: captureFailure,
    });
    const t = setup([meeting], { retireCapture });
    t.deps.lease.confirmSessionLease.mockResolvedValueOnce("lost");

    await t.close.closeMeeting(meeting, button);

    expect(ownership.signal.aborted).toBe(true);
    expect(meeting.recordingCapture).toBeUndefined();
    expect(captureFailure).not.toHaveBeenCalled();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("close waits for a capture-failure save before it frees the server", async () => {
  const meeting = meetingFor();
  let finishSave!: (saved: boolean) => void;
  meeting.recordingPreservationTask = new Promise<boolean>((resolve) => {
    finishSave = resolve;
  });
  const t = setup([meeting], { flushCapture });

  const closing = t.close.closeMeeting(meeting, {
    endReason: "unknown",
    abnormal: true,
  });
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  expect(t.deps.finish.recordCaptureEnd).not.toHaveBeenCalled();
  expect(t.deps.retireCapture).not.toHaveBeenCalled();
  t.calls.push("saved");
  finishSave(true);
  await closing;

  // The failure's pieces and coverage land before the capture end, the retire and the release.
  expect(t.calls.slice(t.calls.indexOf("saved"))).toEqual([
    "saved",
    "record",
    "retire",
    "release",
    "drop",
    "unprotect",
    "prepare",
    "finish",
  ]);
});

test("a capture-failure save that hangs does not hold close past its flush bound", async () => {
  const meeting = meetingFor();
  meeting.recordingPreservationTask = never();
  const t = setup([meeting], { flushCapture });
  t.deps.sleep.mockImplementation((ms: number) =>
    ms === LIFECYCLE.closeFlushMs ? Promise.resolve() : never(),
  );

  await t.close.closeMeeting(meeting, { endReason: "unknown", abnormal: true });

  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});
