import { z } from "zod";
import {
  notesDeliveryTimingSchema,
  type NotesDeliveryTiming,
} from "../types/meetingNotesTiming";
import {
  recordingCaptureStateSchema,
  type RecordingCaptureState,
} from "../types/recordingCheckpoint";

export type NotesLatencyProperties =
  | {
      notes_latency_status: "measured";
      notes_first_delivery_latency_ms: number;
      notes_complete_delivery_latency_ms: number;
      notes_delivery_path: NotesDeliveryTiming["path"];
    }
  | {
      notes_latency_status: "partial";
      notes_first_delivery_latency_ms: number;
      notes_delivery_path: NotesDeliveryTiming["path"];
    }
  | {
      notes_latency_status: "unknown";
      notes_delivery_path?: NotesDeliveryTiming["path"];
    }
  | { notes_latency_status: "not_applicable" };

export function recordNotesAcknowledgement(
  previous: NotesDeliveryTiming | undefined,
  input: {
    acknowledgedAt: string;
    complete: boolean;
    path: NotesDeliveryTiming["path"];
  },
): NotesDeliveryTiming | undefined {
  const existing = notesDeliveryTimingSchema.safeParse(previous);
  if (existing.success && existing.data.kind === "complete")
    return existing.data;

  if (!z.iso.datetime({ offset: true }).safeParse(input.acknowledgedAt).success)
    return undefined;
  if (
    existing.success &&
    Date.parse(input.acknowledgedAt) <
      Date.parse(existing.data.firstAcknowledgedAt)
  )
    return undefined;

  const first = existing.success
    ? existing.data
    : {
        notesVersion: 1,
        path: input.path,
        firstAcknowledgedAt: input.acknowledgedAt,
      };
  const result = notesDeliveryTimingSchema.safeParse(
    input.complete
      ? {
          ...first,
          kind: "complete",
          completeAcknowledgedAt: input.acknowledgedAt,
        }
      : { ...first, kind: "first" },
  );
  return result.success ? result.data : undefined;
}

export function getNotesLatencyProperties(input: {
  capture: RecordingCaptureState | undefined;
  timing: NotesDeliveryTiming | undefined;
  eligible: boolean;
}): NotesLatencyProperties {
  if (!input.eligible) return { notes_latency_status: "not_applicable" };

  const timing = notesDeliveryTimingSchema.safeParse(input.timing);
  if (!timing.success) return { notes_latency_status: "unknown" };
  const path = timing.data.path;
  const capture = recordingCaptureStateSchema.safeParse(input.capture);
  if (
    !capture.success ||
    (capture.data.kind !== "complete" && capture.data.kind !== "interrupted") ||
    capture.data.endedAt === null
  )
    return { notes_latency_status: "unknown", notes_delivery_path: path };

  const stoppedAt = Date.parse(capture.data.endedAt);
  const first = Date.parse(timing.data.firstAcknowledgedAt) - stoppedAt;
  if (!Number.isFinite(first) || first < 0)
    return { notes_latency_status: "unknown", notes_delivery_path: path };
  if (timing.data.kind === "first")
    return {
      notes_latency_status: "partial",
      notes_first_delivery_latency_ms: first,
      notes_delivery_path: path,
    };

  const complete = Date.parse(timing.data.completeAcknowledgedAt) - stoppedAt;
  if (!Number.isFinite(complete) || complete < first)
    return { notes_latency_status: "unknown", notes_delivery_path: path };
  return {
    notes_latency_status: "measured",
    notes_first_delivery_latency_ms: first,
    notes_complete_delivery_latency_ms: complete,
    notes_delivery_path: path,
  };
}
