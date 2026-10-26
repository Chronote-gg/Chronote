import type { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import type {
  CaptureCoverage,
  CaptureCoverageSummary,
  RecoveryDisposition,
} from "../types/recordingCheckpoint";
import { captureCoverageSummarySchema } from "../types/recordingCheckpoint";
import { PARTIAL_TRANSCRIPT_NOTICE } from "./meetingProcessing";

export type CaptureNoticeInput = Pick<
  MeetingHistory,
  "capture" | "captureCoverage" | "processing" | "status" | "notes"
>;
export type PublicRecoveryState =
  | Pick<
      Extract<RecoveryDisposition, { disposition: "done" }>,
      "disposition" | "stage" | "outcome"
    >
  | Pick<
      Exclude<RecoveryDisposition, { disposition: "done" }>,
      "disposition" | "stage"
    >;
export type MeetingCapturePresentation = CaptureNoticeInput & {
  captureNotice?: string;
  recovery?: PublicRecoveryState;
  recoveryNotice?: string;
};

export function summarizeCaptureCoverage(
  coverage: CaptureCoverage,
): CaptureCoverageSummary {
  return captureCoverageSummarySchema.parse(
    coverage.kind === "verified"
      ? {
          kind: coverage.kind,
          savedDurationMs: coverage.savedDurationMs,
          lastConfirmedCaptureAt: coverage.lastConfirmedCaptureAt,
          ...(coverage.stoppedAt ? { stoppedAt: coverage.stoppedAt } : {}),
        }
      : { kind: "unknown" },
  );
}

export function resolveCaptureStatus(input: CaptureNoticeInput) {
  return input.capture?.kind === "interrupted"
    ? MEETING_STATUS.INTERRUPTED
    : (input.status ?? MEETING_STATUS.COMPLETE);
}

export function formatMeetingCaptureNotice(
  input: CaptureNoticeInput,
): string | undefined {
  const interrupted =
    input.capture?.kind === "interrupted" ||
    input.status === MEETING_STATUS.INTERRUPTED;
  if (!interrupted)
    return input.processing?.transcription === "partial"
      ? PARTIAL_TRANSCRIPT_NOTICE
      : input.processing?.transcription === "failed"
        ? input.notes?.trim()
          ? PARTIAL_TRANSCRIPT_NOTICE
          : "Audio could not be transcribed, so no notes were generated."
        : undefined;
  const coverage = input.captureCoverage;
  const saved =
    coverage?.kind === "verified"
      ? `Confirmed saved audio: ${coverage.savedDurationMs / 1000} seconds. Saved audio may contain gaps.`
      : "Saved recording coverage is unknown.";
  const end =
    input.capture?.kind === "interrupted" && input.capture.endedAt
      ? ""
      : " The exact recording end time is unknown.";
  const missing =
    input.processing?.transcription === "partial" ||
    input.processing?.transcription === "failed"
      ? ` ${PARTIAL_TRANSCRIPT_NOTICE}`
      : "";
  return `Partial notes: recording was interrupted. These notes cover only the saved recording. ${saved}${end}${missing}`;
}

export function formatRecoveryNotice(
  recovery?: RecoveryDisposition | PublicRecoveryState,
) {
  switch (recovery?.disposition) {
    case "pending":
    case "claimed":
      return "Recovering saved recording.";
    case "failed":
      return "Recovery could not finish. Available content may be incomplete.";
    case "needs_reconciliation":
      return "Recovery needs review. Processing or delivery could not be confirmed.";
    case "done":
      return recovery.outcome === "disabled"
        ? "Recovery finished with the original transcription and notes settings."
        : recovery.outcome === "no_usable_speech"
          ? "No usable saved speech was found."
          : recovery.outcome === "no_verified_checkpoint"
            ? "No verified saved recording is available."
            : "Saved recording recovery finished.";
    default:
      return undefined;
  }
}

/** Only scalar presentation data leaves the protected history record. */
export function projectMeetingCapture(
  input: CaptureNoticeInput & Pick<MeetingHistory, "recovery">,
): MeetingCapturePresentation {
  const recovery: PublicRecoveryState | undefined =
    input.recovery?.disposition === "done"
      ? {
          disposition: "done",
          stage: input.recovery.stage,
          outcome: input.recovery.outcome,
        }
      : input.recovery
        ? {
            disposition: input.recovery.disposition,
            stage: input.recovery.stage,
          }
        : undefined;
  return {
    capture:
      input.capture?.kind === "complete"
        ? {
            kind: "complete",
            startedAt: input.capture.startedAt,
            endedAt: input.capture.endedAt,
          }
        : input.capture?.kind === "interrupted"
          ? {
              kind: "interrupted",
              startedAt: input.capture.startedAt,
              endedAt: input.capture.endedAt,
              detectedAt: input.capture.detectedAt,
            }
          : input.capture?.kind === "capturing"
            ? { kind: "capturing", startedAt: input.capture.startedAt }
            : input.capture
              ? { kind: input.capture.kind }
              : undefined,
    captureCoverage:
      input.captureCoverage?.kind === "verified"
        ? {
            kind: "verified",
            savedDurationMs: input.captureCoverage.savedDurationMs,
            lastConfirmedCaptureAt:
              input.captureCoverage.lastConfirmedCaptureAt,
            ...(input.captureCoverage.stoppedAt
              ? { stoppedAt: input.captureCoverage.stoppedAt }
              : {}),
          }
        : input.captureCoverage
          ? { kind: "unknown" }
          : undefined,
    captureNotice: formatMeetingCaptureNotice(input),
    recovery,
    recoveryNotice: formatRecoveryNotice(input.recovery),
  };
}

export function withMeetingCaptureNotice(
  text: string,
  input: CaptureNoticeInput,
) {
  const notice = formatMeetingCaptureNotice(input);
  return notice ? `${notice}\n\n${text}` : text;
}
