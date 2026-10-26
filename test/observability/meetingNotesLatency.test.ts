import {
  getNotesLatencyProperties,
  recordNotesAcknowledgement,
} from "../../src/observability/meetingNotesLatency";
import {
  notesDeliveryTimingSchema,
  type NotesDeliveryTiming,
} from "../../src/types/meetingNotesTiming";
import type { RecordingCaptureState } from "../../src/types/recordingCheckpoint";

const capture: RecordingCaptureState = {
  kind: "complete",
  startedAt: "2026-10-16T11:00:00.000Z",
  endedAt: "2026-10-16T12:00:00.000Z",
};
const firstAt = "2026-10-16T12:00:30.000Z";
const completeAt = "2026-10-16T12:00:45.000Z";
const firstTiming: NotesDeliveryTiming = {
  kind: "first",
  notesVersion: 1,
  path: "live",
  firstAcknowledgedAt: firstAt,
};

describe("initial notes delivery timing", () => {
  it("derives partial then complete delivery wait", () => {
    const first = recordNotesAcknowledgement(undefined, {
      acknowledgedAt: firstAt,
      complete: false,
      path: "live",
    });
    const complete = recordNotesAcknowledgement(first, {
      acknowledgedAt: completeAt,
      complete: true,
      path: "live",
    });
    expect(
      getNotesLatencyProperties({ capture, timing: first, eligible: true }),
    ).toEqual({
      notes_latency_status: "partial",
      notes_first_delivery_latency_ms: 30000,
      notes_delivery_path: "live",
    });
    expect(
      getNotesLatencyProperties({ capture, timing: complete, eligible: true }),
    ).toEqual({
      notes_latency_status: "measured",
      notes_first_delivery_latency_ms: 30000,
      notes_complete_delivery_latency_ms: 45000,
      notes_delivery_path: "live",
    });
  });

  it("uses the same acknowledgement for one-batch notes", () => {
    expect(
      recordNotesAcknowledgement(undefined, {
        acknowledgedAt: firstAt,
        complete: true,
        path: "recovery",
      }),
    ).toEqual({
      kind: "complete",
      notesVersion: 1,
      path: "recovery",
      firstAcknowledgedAt: firstAt,
      completeAcknowledgedAt: firstAt,
    });
  });

  it("preserves the initial complete timing", () => {
    const complete = recordNotesAcknowledgement(firstTiming, {
      acknowledgedAt: completeAt,
      complete: true,
      path: "live",
    });
    expect(
      recordNotesAcknowledgement(complete, {
        acknowledgedAt: "2026-10-17T12:00:00.000Z",
        complete: true,
        path: "recovery",
      }),
    ).toEqual(complete);
    expect(
      recordNotesAcknowledgement(complete, {
        acknowledgedAt: "invalid",
        complete: false,
        path: "recovery",
      }),
    ).toEqual(complete);
  });

  it("preserves the first acknowledgement and path through completion", () => {
    expect(
      recordNotesAcknowledgement(firstTiming, {
        acknowledgedAt: completeAt,
        complete: false,
        path: "recovery",
      }),
    ).toEqual(firstTiming);
    expect(
      recordNotesAcknowledgement(firstTiming, {
        acknowledgedAt: completeAt,
        complete: true,
        path: "recovery",
      }),
    ).toEqual({
      ...firstTiming,
      kind: "complete",
      completeAcknowledgedAt: completeAt,
    });
  });

  it.each<RecordingCaptureState | undefined>([
    undefined,
    { kind: "unknown" },
    { kind: "not_started" },
    { kind: "capturing", startedAt: "2026-10-16T11:00:00.000Z" },
    {
      kind: "interrupted",
      startedAt: firstAt,
      detectedAt: completeAt,
      endedAt: null,
    },
  ])("omits elapsed values when the stop is unknown (%j)", (unknownCapture) => {
    expect(
      getNotesLatencyProperties({
        capture: unknownCapture,
        timing: firstTiming,
        eligible: true,
      }),
    ).toEqual({ notes_latency_status: "unknown", notes_delivery_path: "live" });
  });

  it("uses the actual interrupted stop for recovered notes", () => {
    expect(
      getNotesLatencyProperties({
        capture: {
          kind: "interrupted",
          startedAt: "2026-10-16T11:00:00.000Z",
          endedAt: "2026-10-16T12:00:00.000Z",
          detectedAt: "2026-10-16T12:01:00.000Z",
        },
        timing: { ...firstTiming, path: "recovery" },
        eligible: true,
      }),
    ).toEqual({
      notes_latency_status: "partial",
      notes_first_delivery_latency_ms: 30000,
      notes_delivery_path: "recovery",
    });
  });

  it("omits elapsed values when capture ends after the acknowledgement", () => {
    expect(
      getNotesLatencyProperties({
        capture: { kind: "complete", startedAt: firstAt, endedAt: completeAt },
        timing: firstTiming,
        eligible: true,
      }),
    ).toEqual({ notes_latency_status: "unknown", notes_delivery_path: "live" });
  });

  it("omits elapsed values for malformed capture clocks", () => {
    expect(
      getNotesLatencyProperties({
        capture: { kind: "complete", startedAt: firstAt, endedAt: "invalid" },
        timing: firstTiming,
        eligible: true,
      }),
    ).toEqual({ notes_latency_status: "unknown", notes_delivery_path: "live" });
  });

  it.each<NotesDeliveryTiming | undefined>([
    undefined,
    { ...firstTiming, firstAcknowledgedAt: "invalid" },
    {
      ...firstTiming,
      kind: "complete",
      completeAcknowledgedAt: "2026-10-16T12:00:20.000Z",
    },
  ])("omits elapsed values for missing or malformed timing (%j)", (timing) => {
    expect(
      getNotesLatencyProperties({ capture, timing, eligible: true }),
    ).toEqual({
      notes_latency_status: "unknown",
    });
  });

  it("marks ineligible notes as not applicable", () => {
    expect(
      getNotesLatencyProperties({
        capture,
        timing: firstTiming,
        eligible: false,
      }),
    ).toEqual({
      notes_latency_status: "not_applicable",
    });
    expect(
      getNotesLatencyProperties({
        capture: undefined,
        timing: undefined,
        eligible: false,
      }),
    ).toEqual({ notes_latency_status: "not_applicable" });
  });

  it("does not invent an earlier first time after an unavailable observation", () => {
    const unavailable = recordNotesAcknowledgement(undefined, {
      acknowledgedAt: "invalid",
      complete: false,
      path: "live",
    });
    expect(unavailable).toBeUndefined();
    expect(
      recordNotesAcknowledgement(unavailable, {
        acknowledgedAt: completeAt,
        complete: true,
        path: "live",
      }),
    ).toEqual({
      kind: "complete",
      notesVersion: 1,
      path: "live",
      firstAcknowledgedAt: completeAt,
      completeAcknowledgedAt: completeAt,
    });
  });

  it("returns no new timing for invalid or backwards acknowledgement clocks", () => {
    expect(
      recordNotesAcknowledgement(firstTiming, {
        acknowledgedAt: "invalid",
        complete: true,
        path: "live",
      }),
    ).toBeUndefined();
    expect(
      recordNotesAcknowledgement(firstTiming, {
        acknowledgedAt: "2026-10-16T12:00:20.000Z",
        complete: true,
        path: "live",
      }),
    ).toBeUndefined();
  });

  it("ignores malformed previous timing without inventing an earlier timestamp", () => {
    expect(
      recordNotesAcknowledgement(
        { ...firstTiming, firstAcknowledgedAt: "invalid" },
        {
          acknowledgedAt: completeAt,
          complete: true,
          path: "recovery",
        },
      ),
    ).toEqual({
      kind: "complete",
      notesVersion: 1,
      path: "recovery",
      firstAcknowledgedAt: completeAt,
      completeAcknowledgedAt: completeAt,
    });
  });

  it.each([
    { ...firstTiming, notesVersion: 2 },
    { ...firstTiming, firstAcknowledgedAt: "2026-02-30T12:00:00.000Z" },
    { ...firstTiming, kind: "complete" },
    { ...firstTiming, completeAcknowledgedAt: completeAt },
  ])("rejects malformed persisted timing (%j)", (timing) => {
    expect(notesDeliveryTimingSchema.safeParse(timing).success).toBe(false);
  });
});
