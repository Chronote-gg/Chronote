import type { MeetingData } from "../../src/types/meeting-data";
import {
  withMeetingEndStep,
  withMeetingEndTrace,
} from "../../src/observability/meetingTrace";
import { updateActiveObservation } from "@langfuse/tracing";

jest.mock("../../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => true,
}));
jest.mock("@langfuse/tracing", () => ({
  propagateAttributes: (_attributes: unknown, run: () => unknown) => run(),
  startActiveObservation: (_name: string, run: (span: unknown) => unknown) =>
    run({ otelSpan: { spanContext: () => ({}) } }),
  setActiveTraceIO: jest.fn(),
  updateActiveObservation: jest.fn(),
}));

function meeting(): MeetingData {
  return {
    meetingId: "meeting",
    guildId: "guild",
    channelId: "text",
    creator: { id: "creator" },
    voiceChannel: { id: "voice", name: "Voice" },
    startTime: new Date("2026-09-16T12:00:00Z"),
    audioData: {
      audioFiles: [
        { processing: false, transcript: "usable" },
        { processing: false, transcriptionFailed: true },
      ],
      currentSnippets: new Map(),
    },
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "failed",
    },
  } as unknown as MeetingData;
}

beforeEach(() => jest.mocked(updateActiveObservation).mockClear());

test("attaches a terminal generation outcome to its step", async () => {
  const value = meeting();
  await withMeetingEndStep(value, "generate-summary", async () => ({}));
  expect(updateActiveObservation).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "ERROR",
      metadata: { stageOutcome: "failed" },
    }),
    { asType: "chain" },
  );
});

test("records processing facts and failed stages on the root trace", async () => {
  const value = meeting();
  await withMeetingEndTrace(value, async () => undefined);
  expect(updateActiveObservation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level: "ERROR",
      metadata: expect.objectContaining({
        processing: value.processing,
        usableSegments: 1,
        failedSegments: 1,
        captureIncomplete: false,
      }),
    }),
    { asType: "chain" },
  );
});
