import { randomUUID } from "node:crypto";
import { processingRetryJobs } from "../metrics";
import { getMeetingHistoryRepository } from "../repositories/meetingHistoryRepository";
import { getProcessingRetryRepository } from "../repositories/processingRetryRepository";
import type { MeetingHistory } from "../types/db";
import {
  PROCESSING_RETRY_QUEUE,
  type ProcessingRetryIneligibleReason,
  type ProcessingRetryJob,
} from "../types/meetingProcessingRetry";
import {
  readMeetingUpdateRevisions,
  type MeetingUpdateKey,
} from "../types/meetingUpdateDelivery";
import { captureEvent } from "./analyticsService";
import { isProcessingRetryAvailable } from "./processingRetryAvailability";
import { getProcessingRetryEligibility } from "./processingRetryEligibility";

export type ProcessingRetryRequest = {
  key: MeetingUpdateKey;
  requestedBy: string;
  replaceNotes: boolean;
  source: "portal" | "operator";
};
export type ProcessingRetryRequestResult =
  | { kind: "queued"; history: MeetingHistory; job: ProcessingRetryJob }
  | { kind: "unavailable" }
  | {
      kind: "ineligible";
      reason: ProcessingRetryIneligibleReason | "replace_confirmation_required";
    }
  | { kind: "conflict" };

export async function requestProcessingRetry(
  input: ProcessingRetryRequest,
): Promise<ProcessingRetryRequestResult> {
  if (!(await isProcessingRetryAvailable())) return { kind: "unavailable" };
  const row = await getMeetingHistoryRepository().getStrong(input.key);
  if (!row) return { kind: "conflict" };
  const eligibility = getProcessingRetryEligibility(row, input.source);
  if (!eligibility.eligible)
    return { kind: "ineligible", reason: eligibility.reason };
  if (eligibility.requiresReplaceConfirm && !input.replaceNotes)
    return { kind: "ineligible", reason: "replace_confirmation_required" };
  const now = new Date();
  const job: ProcessingRetryJob = {
    jobId: randomUUID(),
    status: "queued",
    stages: eligibility.stages,
    requestedBy: input.requestedBy,
    requestedAt: now.toISOString(),
    expectedNotesVersion: readMeetingUpdateRevisions(row).notesVersion,
    replaceNotes: input.replaceNotes,
    countedAttempts: row.processingRetry?.countedAttempts ?? 0,
    // A prediction for the portal; the worker records the settings it actually used.
    settingsSource: row.checkpoint ? "snapshot" : "current",
    transcriptSource: eligibility.transcriptSource,
    updatedAt: now.toISOString(),
  };
  const dueAt = Math.floor(now.getTime() / 1000);
  const queued = await getProcessingRetryRepository().queue({
    key: input.key,
    expected: {
      processing: row.processing,
      notesVersion: row.notesVersion,
      processingRetry: row.processingRetry,
    },
    job,
    dueAt,
  });
  if (queued === "conflict") return { kind: "conflict" };
  processingRetryJobs.inc({ outcome: "queued", reason: "none" });
  captureEvent("meeting_processing_retry_requested", {
    userId: input.requestedBy,
    guildId: row.guildId,
    properties: {
      stages: job.stages,
      source: input.source,
      replace_notes: input.replaceNotes,
      settings_source: job.settingsSource,
    },
  });
  return {
    kind: "queued",
    job,
    history: {
      ...row,
      processingRetry: job,
      processingRetryQueue: PROCESSING_RETRY_QUEUE,
      processingRetryDueAt: dueAt,
    },
  };
}
