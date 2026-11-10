/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/recordingContentService");

import { createMeeting } from "./fixtures/voiceSubscriptionMeeting";
import { subscribeToUserVoice, stopRecordingCapture } from "../../src/audio";
import { OpusDiagnosticDecoder } from "../../src/utils/opusDiagnosticDecoder";
import { PassThrough } from "node:stream";

test("pending encrypted input marks capture incomplete without closing or retrying the stream", async () => {
  jest.useFakeTimers();
  const streams: PassThrough[] = [];
  const { meeting } = createMeeting(streams);
  const destroy = jest.spyOn(OpusDiagnosticDecoder.prototype, "destroy");
  try {
    await subscribeToUserVoice(meeting, "user-1");
    streams[0].emit("davePendingInput");
    expect(meeting.audioData.captureIncomplete).toBe(true);
    expect(streams[0].destroyed).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    stopRecordingCapture(meeting);
    destroy.mockRestore();
    jest.useRealTimers();
  }
  expect(streams[0].listenerCount("davePendingInput")).toBe(0);
});
