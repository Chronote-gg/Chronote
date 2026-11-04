import type { MeetingHistory } from "../../src/types/db";
import {
  PROCESSING_RETRY_QUEUE,
  type ProcessingRetryJob,
} from "../../src/types/meetingProcessingRetry";
import { history, now } from "../types/meetingUpdateDelivery.fixture";

const iso = "2026-10-28T12:00:00.000Z";
export const failedNotes = {
  transcription: "ready",
  notes: "failed",
  summary: "skipped",
} as const;
export const queuedJob: ProcessingRetryJob = {
  jobId: "job-1",
  status: "queued",
  stages: ["notes", "summary"],
  requestedBy: "111111111111111111",
  requestedAt: iso,
  expectedNotesVersion: 1,
  replaceNotes: false,
  countedAttempts: 0,
  settingsSource: "current",
  transcriptSource: "existing",
  updatedAt: iso,
};
export const failedRow = (): MeetingHistory => ({
  ...history(),
  contentRevision: 3,
  processing: failedNotes,
});
export const expectedOf = (row: MeetingHistory) => ({
  processing: row.processing,
  notesVersion: row.notesVersion,
  processingRetry: row.processingRetry,
});
export const queuedRow = (
  patch: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  ...failedRow(),
  processingRetry: queuedJob,
  processingRetryQueue: PROCESSING_RETRY_QUEUE,
  processingRetryDueAt: now,
  ...patch,
});

export function failedJob(running: ProcessingRetryJob): ProcessingRetryJob {
  return {
    ...running,
    status: "failed",
    failureReason: "stage_failed",
    countedAttempts: running.countedAttempts + 1,
    claim: undefined,
  };
}
