import type { MeetingHistory } from "../types/db";
import type { CompletionPolicy } from "../types/meetingCompletionPolicy";
import {
  finishedMeetingStatus,
  MEETING_END_REASONS,
  MEETING_STATUS,
  type MeetingStatus,
} from "../types/meetingLifecycle";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import { TRANSCRIPTION_FAILED } from "../utils/meetingProcessing";
import { trimNotesForHistory } from "../utils/notesHistory";
import { LIFECYCLE } from "./lifecycleTiming";
import type { FinishInput } from "./meetingFinishInput";

const MS_PER_SECOND = 1000;

const captureEndIso = (row: MeetingHistory) =>
  new Date(
    Date.parse(row.timestamp) + row.duration * MS_PER_SECOND,
  ).toISOString();

function terminalStatus(row: MeetingHistory, input: FinishInput) {
  if (input.cancel) return MEETING_STATUS.CANCELLED;
  return finishedMeetingStatus(row.capture);
}

function notesVersionFields(row: MeetingHistory, input: FinishInput) {
  const notes = input.notesInput.notesText;
  if (!notes) return {};
  const notesVersion = row.notesVersion ?? 1;
  const notesLastEditedBy =
    row.notesLastEditedBy ??
    row.meetingCreatorId ??
    input.notesInput.creator.id;
  const notesLastEditedAt = row.notesLastEditedAt ?? captureEndIso(row);
  return {
    notesVersion,
    notesLastEditedBy,
    notesLastEditedAt,
    notesHistory: [
      {
        version: notesVersion,
        notes: trimNotesForHistory(notes),
        editedBy: notesLastEditedBy,
        editedAt: notesLastEditedAt,
      },
    ],
  };
}

/**
 * What today's cancellation stores: the decision, its reason and how it ended.
 * The stored policy schema requires the full snapshot, so the decision is
 * written onto the row's snapshot or the one the loader carries.
 */
function cancellationFields(
  row: MeetingHistory,
  input: FinishInput,
): Partial<MeetingHistory> {
  const decision: CompletionPolicy["decision"] = input.cancel
    ? "cancel"
    : "proceed";
  const snapshot = row.completionPolicy ?? input.completionPolicy;
  return {
    ...(snapshot ? { completionPolicy: { ...snapshot, decision } } : {}),
    ...(input.cancel
      ? {
          cancellationReason: input.cancel.reason,
          endReason:
            row.endReason === MEETING_END_REASONS.DISMISSED
              ? MEETING_END_REASONS.DISMISSED
              : MEETING_END_REASONS.AUTO_CANCELLED,
        }
      : {}),
  };
}

/** A decision close already wrote is final: a retry or another loader never reverses it. */
export function withRowDecision(
  row: MeetingHistory,
  input: FinishInput,
): FinishInput {
  const decided = row.completionPolicy?.decision;
  if (decided === "cancel" && !input.cancel)
    return { ...input, cancel: { reason: row.cancellationReason } };
  if (decided === "proceed" && input.cancel) {
    return { ...input, cancel: undefined };
  }
  return input;
}

export function processingOutcome(
  input: FinishInput,
): MeetingProcessingOutcome {
  const notes = input.notesInput;
  const processing = { ...input.processing, ...notes.processing };
  // Recovery records notes as skipped when the recording asked for none.
  return !notes.generateNotes && notes.transcribeMeeting && !input.cancel
    ? { ...processing, notes: "skipped", summary: "skipped" }
    : processing;
}

/**
 * The stages as stored when steps 1 to 3 gave up, so a portal retry can rerun
 * them: generation outcomes as recorded, else a failure before notes (loading,
 * transcription or storing the transcript) as transcription failed. A failed
 * row stores no notes, so notes generated in the failed attempt count as
 * failed. A cancellation records nothing, so no retry is offered for it.
 */
export function failedProcessing(
  input: FinishInput | undefined,
): MeetingProcessingOutcome | undefined {
  if (input?.cancel) return undefined;
  const outcome = input && processingOutcome(input);
  if (!outcome || !Object.values(outcome).includes("failed"))
    return TRANSCRIPTION_FAILED;
  return outcome.notes === "generated"
    ? { ...outcome, notes: "failed" }
    : outcome;
}

/** What the terminal save writes over `row`, the latest acknowledged row. */
export function terminalPatch(
  row: MeetingHistory,
  input: FinishInput,
  owner: string,
  now: number,
): Partial<MeetingHistory> & { status: MeetingStatus } {
  const notes = input.notesInput;
  return {
    status: terminalStatus(row, input),
    notes: input.cancel ? undefined : notes.notesText,
    meetingName: notes.meetingName,
    summarySentence: notes.summarySentence,
    summaryLabel: notes.summaryLabel,
    processing: processingOutcome(input),
    participants: input.participants,
    tags: notes.tags,
    ...(input.cancel ? {} : notesVersionFields(row, input)),
    ...cancellationFields(row, input),
    ...(input.captureCoverage && !row.captureCoverage
      ? { captureCoverage: input.captureCoverage }
      : {}),
    updatedAt: new Date(now * MS_PER_SECOND).toISOString(),
    finish: {
      ...(row.finish?.startedAt === undefined
        ? {}
        : { startedAt: row.finish.startedAt }),
      owner,
      expiresAt: now + LIFECYCLE.finishClaimSeconds,
      attempts: 0,
      phase: "deliver",
    },
  };
}
