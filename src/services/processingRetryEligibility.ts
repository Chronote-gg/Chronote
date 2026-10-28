import type { MeetingHistory } from "../types/db";
import {
  PROCESSING_RETRY_USER_ATTEMPT_CAP,
  type ProcessingRetryEligibility,
  type ProcessingRetryIneligibleReason,
  type ProcessingRetryJob,
  type ProcessingRetryStage,
  type ProcessingRetryView,
} from "../types/meetingProcessingRetry";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import {
  originalPublicationUnsettled,
  publicationSnapshot,
} from "../types/meetingPublication";
import { readMeetingUpdateRevisions } from "../types/meetingUpdateDelivery";
import { isPersonalMeeting } from "../utils/meetingOwnership";

type Actor = "portal" | "operator";

const ALL_STAGES: readonly ProcessingRetryStage[] = [
  "transcription",
  "notes",
  "summary",
];

export function notesEditedByPerson(
  history: Pick<MeetingHistory, "notesVersion" | "notesHistory">,
): boolean {
  const { notesVersion } = readMeetingUpdateRevisions({
    notesVersion: history.notesVersion,
  });
  for (let version = 2; version <= notesVersion; version++) {
    const entry = history.notesHistory?.find(
      (candidate) => candidate.version === version,
    );
    if (entry?.source?.type !== "processing_retry") return true;
  }
  return false;
}

function hasUsableTranscript(
  history: MeetingHistory,
  processing: MeetingProcessingOutcome,
): boolean {
  return (
    Boolean(history.transcriptS3Key) &&
    (processing.transcription === "ready" ||
      processing.transcription === "partial")
  );
}

/** The row cannot tell an ASR partial from a capture partial, so only the first retry may probe it. */
function partialAlreadyProbed(retry: ProcessingRetryJob | undefined): boolean {
  return (
    retry?.status === "succeeded" || retry?.failureReason === "nothing_to_retry"
  );
}

function selectStages(history: MeetingHistory): ProcessingRetryStage[] {
  const processing = history.processing ?? {};
  const generationFailed =
    processing.notes === "failed" || processing.summary === "failed";
  if (
    processing.transcription === "failed" ||
    (generationFailed && !hasUsableTranscript(history, processing))
  )
    return [...ALL_STAGES];
  if (
    processing.transcription === "partial" &&
    !partialAlreadyProbed(history.processingRetry)
  )
    return [...ALL_STAGES];
  if (processing.notes === "failed") return ["notes", "summary"];
  if (processing.summary === "failed") return ["summary"];
  return [];
}

function transcriptSourceFor(
  history: MeetingHistory,
  stages: ProcessingRetryStage[],
): ProcessingRetryJob["transcriptSource"] | undefined {
  if (!stages.includes("transcription")) return "existing";
  if (history.checkpoint) return "checkpoint";
  return history.audioS3Key ? "mixed" : undefined;
}

function lifecycleBlock(
  history: MeetingHistory,
): ProcessingRetryIneligibleReason | undefined {
  if (isPersonalMeeting(history)) return "personal_meeting";
  if (originalPublicationUnsettled(publicationSnapshot(history)))
    return "processing_in_progress";
  if (!history.processing) return "no_processing_record";
  const status = history.processingRetry?.status;
  if (status === "queued" || status === "running") return "job_active";
  return undefined;
}

function hasStoredNotes(history: MeetingHistory): boolean {
  return Boolean(history.notes?.trim());
}

export function getProcessingRetryEligibility(
  history: MeetingHistory,
  actor: Actor = "portal",
): ProcessingRetryEligibility {
  const blocked = lifecycleBlock(history);
  if (blocked) return { eligible: false, reason: blocked };
  const stages = selectStages(history);
  if (stages.length === 0)
    return {
      eligible: false,
      reason:
        history.processing?.transcription === "partial"
          ? "capture_incomplete"
          : "nothing_failed",
    };
  const transcriptSource = transcriptSourceFor(history, stages);
  const summaryOnly = stages.length === 1 && stages[0] === "summary";
  if (!transcriptSource || (summaryOnly && !hasStoredNotes(history)))
    return { eligible: false, reason: "source_missing" };
  const attempts = history.processingRetry?.countedAttempts ?? 0;
  if (actor === "portal" && attempts >= PROCESSING_RETRY_USER_ATTEMPT_CAP)
    return { eligible: false, reason: "attempts_exhausted" };
  const replacesNotes = stages.includes("notes") && hasStoredNotes(history);
  if (replacesNotes && notesEditedByPerson(history))
    return { eligible: false, reason: "notes_edited" };
  return {
    eligible: true,
    stages,
    transcriptSource,
    requiresReplaceConfirm: replacesNotes,
  };
}

export function projectProcessingRetry(
  history: MeetingHistory,
  blocked?: "unavailable" | "not_permitted",
): ProcessingRetryView {
  const retry = history.processingRetry;
  const eligibility: ProcessingRetryEligibility = blocked
    ? { eligible: false, reason: blocked }
    : getProcessingRetryEligibility(history);
  return {
    eligible: eligibility.eligible,
    reason: eligibility.eligible ? undefined : eligibility.reason,
    requiresReplaceConfirm:
      eligibility.eligible && eligibility.requiresReplaceConfirm,
    status: retry?.status,
    failureReason: retry?.failureReason,
    settingsSource: retry?.settingsSource,
    attemptsRemaining: Math.max(
      0,
      PROCESSING_RETRY_USER_ATTEMPT_CAP - (retry?.countedAttempts ?? 0),
    ),
  };
}
