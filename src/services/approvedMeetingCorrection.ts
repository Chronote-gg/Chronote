import type { MeetingHistory } from "../types/db";
import type { MeetingUpdateMutation } from "../types/meetingUpdateDelivery";
/** Approved correction output becomes explicit changed parts, without generating again. */
export function approvedCorrectionMutation(input: {
  history: Pick<
    MeetingHistory,
    "meetingName" | "summarySentence" | "summaryLabel"
  >;
  notes: string;
  summarySentence?: string;
  summaryLabel?: string;
  meetingName?: string;
}): Extract<MeetingUpdateMutation, { kind: "correction" }> {
  const changes: Extract<
    MeetingUpdateMutation,
    { kind: "correction" }
  >["changes"] = [{ kind: "notes", notes: input.notes, notesDelta: null }];
  if (
    input.summarySentence !== undefined &&
    input.summarySentence !== input.history.summarySentence
  )
    changes.push({ kind: "summarySentence", value: input.summarySentence });
  if (
    input.summaryLabel !== undefined &&
    input.summaryLabel !== input.history.summaryLabel
  )
    changes.push({ kind: "summaryLabel", value: input.summaryLabel });
  if (
    input.meetingName !== undefined &&
    input.meetingName !== input.history.meetingName
  )
    changes.push({ kind: "rename", meetingName: input.meetingName });
  return { kind: "correction", changes };
}
