/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/audio", () => ({
  buildMixedAudio: jest.fn(async () => undefined),
  closeOutputFile: jest.fn(async () => undefined),
  waitForAudioOnlyFinishProcessing: jest.fn(async () => undefined),
  waitForFinishProcessing: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/autoRecordCancellationService", () => ({
  evaluateAutoRecordCancellation: jest.fn(async () => ({ cancel: false })),
}));
jest.mock("../../src/services/transcriptionFinalPassService", () => ({
  runTranscriptionFinalPass: jest.fn(),
}));
jest.mock("../../src/services/transcriptCompilationService", () => ({
  compileTranscriptions: jest.fn(async () => "Cancelled transcript"),
}));
jest.mock("../../src/services/recordingContentService", () => ({
  checkpointCompletedTranscription: jest.fn(),
  guardRecordingFinalization: jest.fn(),
}));
jest.mock("../../src/services/imageCaptionService", () => ({
  captionMeetingImages: jest.fn(async () => undefined),
}));

import type { Client } from "discord.js";
import { waitForFinishProcessing } from "../../src/audio";
import { evaluateAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import {
  compileCancelledTranscript,
  compileFinalTranscript,
  resolveMeetingCancellation,
  settleCapturedAudio,
} from "../../src/services/meetingCaptureWrapUp";
import { checkpointCompletedTranscription } from "../../src/services/recordingContentService";
import { compileTranscriptions } from "../../src/services/transcriptCompilationService";
import { runTranscriptionFinalPass } from "../../src/services/transcriptionFinalPassService";
import type { MeetingData } from "../../src/types/meeting-data";
import { MEETING_END_REASONS } from "../../src/types/meetingLifecycle";

const START_MS = Date.parse("2025-01-01T00:00:00.000Z");
const ELEVEN_MINUTES_MS = 11 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;

const finalPass = {
  enabled: true,
  applied: true,
  processedChunks: 1,
  totalChunks: 1,
  totalSegments: 1,
  candidateEdits: 0,
  acceptedEdits: 0,
  replacedSegments: 0,
  droppedSegments: 0,
  rejectedTrivialEdits: 0,
  repetitionFilteredSegments: 0,
  fallbackApplied: false,
};

function meetingFor(overrides: Partial<MeetingData> = {}): MeetingData {
  return {
    guildId: "synthetic-guild",
    meetingId: "synthetic-meeting",
    startTime: new Date(START_MS),
    chatLog: [],
    transcribeMeeting: true,
    isAutoRecording: false,
    audioData: {
      audioFiles: [],
      currentSnippets: new Map(),
      outputFileName: "synthetic/recording.mp3",
    },
    ...overrides,
  } as unknown as MeetingData;
}

function dismissed(durationMs: number, chatMessages = 0): MeetingData {
  return meetingFor({
    isAutoRecording: true,
    cancelled: true,
    cancellationReason: "Stopped by user",
    endReason: MEETING_END_REASONS.DISMISSED,
    endTime: new Date(START_MS + durationMs),
    chatLog: Array.from({ length: chatMessages }, (_, index) => ({
      type: "message",
      content: `message ${index}`,
    })) as MeetingData["chatLog"],
  });
}

const audioFile = (fields: object) =>
  ({ userId: "synthetic-speaker", timestamp: START_MS, ...fields }) as never;

const signal = () => new AbortController().signal;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.mocked(runTranscriptionFinalPass).mockResolvedValue(finalPass);
  jest.mocked(waitForFinishProcessing).mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

test("a dismissed auto-recording past the duration threshold proceeds without the automatic evaluation", async () => {
  const meeting = dismissed(ELEVEN_MINUTES_MS);

  expect(await resolveMeetingCancellation(meeting)).toEqual({
    kind: "proceed",
  });

  expect(evaluateAutoRecordCancellation).not.toHaveBeenCalled();
  expect(meeting.cancelled).toBe(false);
  expect(meeting.cancellationReason).toBeUndefined();
});

test("a short dismissed auto-recording proceeds when chat activity crosses the threshold", async () => {
  const meeting = dismissed(TWO_MINUTES_MS, 2);

  expect(await resolveMeetingCancellation(meeting)).toEqual({
    kind: "proceed",
  });

  expect(evaluateAutoRecordCancellation).not.toHaveBeenCalled();
  expect(meeting.cancelled).toBe(false);
});

test("a short quiet dismissed auto-recording stays cancelled", async () => {
  const meeting = dismissed(TWO_MINUTES_MS);

  expect(await resolveMeetingCancellation(meeting)).toEqual({
    kind: "cancelled",
  });

  expect(meeting.cancelled).toBe(true);
  expect(meeting.cancellationReason).toBe("Stopped by user");
});

test("the automatic evaluation can cancel an auto-recording", async () => {
  const decision = { cancel: true, reason: "No substantive content" };
  jest.mocked(evaluateAutoRecordCancellation).mockResolvedValueOnce(decision);

  expect(
    await resolveMeetingCancellation(meetingFor({ isAutoRecording: true })),
  ).toEqual({ kind: "automatic", decision });
});

test.each(["failed-segment", "partial", "capture-incomplete"] as const)(
  "required %s processing fails the settle step, so it never reaches automatic cancellation",
  async (failure) => {
    const meeting = meetingFor();
    meeting.audioData.audioFiles = Array.from({ length: 3 }, () =>
      audioFile({
        transcript: "",
        processing: false,
        transcriptionFailed: failure === "failed-segment",
      }),
    );
    meeting.audioData.captureIncomplete = failure === "capture-incomplete";
    if (failure === "partial")
      meeting.processing = { transcription: "partial" };

    await expect(settleCapturedAudio(meeting, signal())).rejects.toThrow(
      "processing",
    );
  },
);

test("settling stops waiting for in-flight transcriptions once the attempt is stopped", async () => {
  jest
    .mocked(waitForFinishProcessing)
    .mockReturnValueOnce(new Promise<void>(() => undefined));
  const attempt = new AbortController();
  const settling = settleCapturedAudio(meetingFor(), attempt.signal);

  attempt.abort(new Error("synthetic claim lost"));

  await expect(settling).rejects.toThrow("synthetic claim lost");
});

test("an attempt already stopped leaves no unhandled rejection from the transcription wait", async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    jest
      .mocked(waitForFinishProcessing)
      .mockImplementationOnce(() =>
        Promise.reject(new Error("synthetic transcription failure")),
      );
    const attempt = new AbortController();
    attempt.abort(new Error("synthetic claim lost"));

    await expect(
      settleCapturedAudio(meetingFor(), attempt.signal),
    ).rejects.toThrow("synthetic claim lost");
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).toEqual([]);
    expect(waitForFinishProcessing).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("deliberately suppressed empty speech is classified empty", async () => {
  const meeting = meetingFor();
  meeting.audioData.audioFiles = [
    audioFile({
      transcript: "",
      processing: false,
      transcriptionFailed: false,
    }),
  ];

  await compileFinalTranscript(meeting, async () => "", "synthetic.mp3");

  expect(meeting.processing?.transcription).toBe("empty");
});

test("transcribed speech is classified ready and the processed transcription is checkpointed", async () => {
  const meeting = meetingFor();
  meeting.audioData.audioFiles = [
    audioFile({ transcript: "Fixture speech", processing: false }),
  ];

  await compileFinalTranscript(
    meeting,
    async ({ cleanupAcknowledged } = {}) => {
      cleanupAcknowledged?.("acknowledged");
      return "Fixture speech";
    },
    "synthetic.mp3",
  );

  expect(meeting.processing?.transcription).toBe("ready");
  expect(meeting.finalTranscript).toBe("Fixture speech");
  expect(checkpointCompletedTranscription).toHaveBeenLastCalledWith(meeting, {
    finalPass: "acknowledged",
    cleanup: "acknowledged",
    finalText: "Fixture speech",
  });
});

test("an incomplete capture with usable speech is classified partial", async () => {
  const meeting = meetingFor();
  meeting.audioData.captureIncomplete = true;
  meeting.audioData.audioFiles = [
    audioFile({ transcript: "Fixture speech", processing: false }),
  ];

  await compileFinalTranscript(
    meeting,
    async () => "Fixture speech",
    "synthetic.mp3",
  );

  expect(meeting.processing?.transcription).toBe("partial");
});

test("a transcription still pending after the wait is classified failed", async () => {
  const meeting = meetingFor();
  meeting.audioData.audioFiles = [
    audioFile({ transcript: "Fixture speech", processing: true }),
  ];

  await compileFinalTranscript(
    meeting,
    async () => "Fixture speech",
    "synthetic.mp3",
  );

  expect(meeting.processing?.transcription).toBe("failed");
});

test("the optional final pass fallback keeps the usable baseline transcript", async () => {
  jest.mocked(runTranscriptionFinalPass).mockResolvedValueOnce({
    ...finalPass,
    applied: false,
    candidateEdits: 1,
    fallbackApplied: true,
    fallbackReason: "guardrail_threshold",
  });
  const meeting = meetingFor();
  meeting.audioData.audioFiles = [
    audioFile({ transcript: "Fixture speech", processing: false }),
  ];

  await compileFinalTranscript(
    meeting,
    async ({ cleanupAcknowledged } = {}) => {
      cleanupAcknowledged?.("disabled");
      return "Fixture speech";
    },
    "synthetic.mp3",
  );

  expect(meeting.processing?.transcription).toBe("ready");
  expect(meeting.audioData.audioFiles[0].transcript).toBe("Fixture speech");
  expect(checkpointCompletedTranscription).toHaveBeenLastCalledWith(
    meeting,
    expect.objectContaining({ finalPass: "fallback" }),
  );
});

test("a cancelled meeting keeps a transcript compiled without the final pass", async () => {
  const meeting = meetingFor();
  meeting.audioData.audioFiles = [
    audioFile({ transcript: "Fixture speech", processing: true }),
  ];
  const client = {} as Client;

  expect(await compileCancelledTranscript(client, meeting)).toBe(
    "Cancelled transcript",
  );

  expect(waitForFinishProcessing).toHaveBeenCalledWith(meeting);
  expect(compileTranscriptions).toHaveBeenCalledWith(client, meeting);
  expect(runTranscriptionFinalPass).not.toHaveBeenCalled();
  expect(meeting.finalTranscript).toBe("Cancelled transcript");
});

test("a cancelled meeting that was not transcribed has no transcript", async () => {
  const meeting = meetingFor({ transcribeMeeting: false });

  expect(
    await compileCancelledTranscript({} as Client, meeting),
  ).toBeUndefined();
  expect(compileTranscriptions).not.toHaveBeenCalled();
});
