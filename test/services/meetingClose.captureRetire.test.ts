/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { retireCapture } from "../../src/services/meetingClose";
import { createRecordingCheckpointCapture } from "../../src/services/recordingCheckpointCapture";
import {
  NOW_MS,
  START_MS,
  button,
  meetingFor,
  never,
  setup,
  useSilencedCloseLogs,
} from "./meetingClose.fixture";

useSilencedCloseLogs();

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
