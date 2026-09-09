import { withMeetingEndTrace } from "../src/observability/meetingTrace";
import { recordDelivery } from "../src/observability/meetingDelivery";
import { updateActiveObservation } from "@langfuse/tracing";
import type { MeetingData } from "../src/types/meeting-data";

it("retains the primary finalization exception when a delivery also failed", async () => {
  jest.mocked(updateActiveObservation).mockClear();
  const meeting = {
    meetingId: "meeting",
    guildId: "guild",
    creator: { id: "creator" },
    voiceChannel: { id: "voice", name: "Voice" },
    startTime: new Date(),
  } as unknown as MeetingData;
  await expect(
    withMeetingEndTrace(meeting, async () => {
      recordDelivery(meeting, "processing", {
        outcome: "failed",
        intended: 1,
        sent: 0,
        errors: [],
      });
      throw new Error("upload failed");
    }),
  ).rejects.toThrow("upload failed");
  const statuses = jest
    .mocked(updateActiveObservation)
    .mock.calls.map(([data]) => data.statusMessage)
    .filter(Boolean);
  expect(statuses.at(-1)).toBe("Error: upload failed");
});

jest.mock("../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => true,
}));
jest.mock("@langfuse/tracing", () => ({
  propagateAttributes: (_attributes: unknown, run: () => unknown) => run(),
  startActiveObservation: (_name: string, run: (span: unknown) => unknown) =>
    run({ otelSpan: { spanContext: () => ({}) } }),
  setActiveTraceIO: jest.fn(),
  updateActiveObservation: jest.fn(),
}));

it("marks the parent trace degraded after a caught delivery failure while letting finalization finish", async () => {
  const meeting = {
    meetingId: "meeting",
    guildId: "guild",
    creator: { id: "creator" },
    voiceChannel: { id: "voice", name: "Voice" },
    startTime: new Date(),
    finished: false,
  } as unknown as MeetingData;
  await withMeetingEndTrace(meeting, async () => {
    recordDelivery(meeting, "notes", {
      outcome: "failed",
      intended: 1,
      sent: 0,
      errors: [{ code: 50013 }],
    });
    meeting.finished = true;
  });
  expect(meeting.finished).toBe(true);
  expect(updateActiveObservation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level: "ERROR",
      metadata: {
        delivery: {
          notes: {
            outcome: "failed",
            intended: 1,
            sent: 0,
            errors: [{ code: 50013 }],
          },
        },
      },
    }),
    { asType: "chain" },
  );
  expect(meeting.langfuseParentSpanContext).toBeUndefined();
});
