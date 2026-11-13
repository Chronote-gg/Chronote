/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import type { VoiceConnection } from "@discordjs/voice";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { flushCapture } from "../../src/services/meetingClose";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  NOW_MS,
  START_MS,
  button,
  meetingFor,
  never,
  setup,
  useSilencedCloseLogs,
  type D,
} from "./meetingClose.fixture";

useSilencedCloseLogs();

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

/** A close on a shutting-down worker whose flush never settles, keeping every bound it waits on. */
function shuttingDownWithHungFlush() {
  const meeting = meetingFor();
  const bounds: number[] = [];
  const sleep = jest.fn<D["sleep"]>(async (ms) => {
    bounds.push(ms);
  });
  const t = setup([meeting], { sleep });
  t.deps.isShuttingDown.mockReturnValue(true);
  t.deps.flushCapture.mockImplementation(() => never());
  return { meeting, bounds, t };
}

test("a close at shutdown flushes within the shutdown bound, writes once, and ends inside its deadline", async () => {
  const { meeting, bounds, t } = shuttingDownWithHungFlush();
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
  const { meeting, bounds, t } = shuttingDownWithHungFlush();

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
  expect(t.deps.restoreNickname).toHaveBeenCalledWith(
    failing,
    expect.any(AbortSignal),
  );
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
