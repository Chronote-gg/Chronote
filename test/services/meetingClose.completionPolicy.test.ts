/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import { performance } from "node:perf_hooks";
import {
  freezeCompletionPolicy,
  stopCompletionClock,
} from "../../src/services/meetingCompletionPolicyService";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  NOW_MS,
  START_MS,
  button,
  meetingFor,
  setup,
  useSilencedCloseLogs,
} from "./meetingClose.fixture";

useSilencedCloseLogs();

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
