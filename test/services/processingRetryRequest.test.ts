/** @jest-environment node */
jest.mock("../../src/services/processingRetryAvailability", () => ({
  isProcessingRetryAvailable: jest.fn(async () => true),
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { captureEvent } from "../../src/services/analyticsService";
import { isProcessingRetryAvailable } from "../../src/services/processingRetryAvailability";
import { requestProcessingRetry } from "../../src/services/processingRetryRequestService";
import type { MeetingHistory } from "../../src/types/db";
import type { ProcessingRetryJob } from "../../src/types/meetingProcessingRetry";
import { history, key } from "../types/meetingUpdateDelivery.fixture";

const userId = "111111111111111111";
const iso = "2026-10-28T12:00:00.000Z";
const base: MeetingHistory = {
  ...history(),
  status: "complete",
  transcriptS3Key: "t/transcript.json",
  audioS3Key: "t/audio.mp3",
  notes: undefined,
  processing: { transcription: "ready", notes: "failed", summary: "skipped" },
};
const failedJob: ProcessingRetryJob = {
  jobId: "job-0",
  status: "failed",
  stages: ["notes", "summary"],
  requestedBy: userId,
  requestedAt: iso,
  expectedNotesVersion: 1,
  replaceNotes: false,
  countedAttempts: 3,
  settingsSource: "current",
  transcriptSource: "existing",
  failureReason: "stage_failed",
  updatedAt: iso,
};

function seed(row: MeetingHistory) {
  getMockStore().meetingHistoryByGuild.set(row.guildId, [structuredClone(row)]);
}
const stored = () =>
  getMockStore()
    .meetingHistoryByGuild.get(key.guildId)
    ?.find((row) => row.channelId_timestamp === key.channelId_timestamp);
const request = (
  patch: Partial<Parameters<typeof requestProcessingRetry>[0]> = {},
) =>
  requestProcessingRetry({
    key,
    requestedBy: userId,
    replaceNotes: false,
    source: "portal",
    ...patch,
  });

beforeEach(() => {
  resetMockStore();
  jest.mocked(isProcessingRetryAvailable).mockResolvedValue(true);
  jest.mocked(captureEvent).mockClear();
});

it("queues a failed meeting with the captured notes version and predicted sources", async () => {
  seed(base);
  const result = await request();
  expect(result).toMatchObject({
    kind: "queued",
    job: {
      status: "queued",
      stages: ["notes", "summary"],
      expectedNotesVersion: 1,
      countedAttempts: 0,
      settingsSource: "current",
      transcriptSource: "existing",
      requestedBy: userId,
      replaceNotes: false,
    },
  });
  expect(stored()).toMatchObject({
    processingRetryQueue: "processing-retry:v1",
    processingRetryDueAt: expect.any(Number),
  });
  expect(result.kind === "queued" && result.history).toEqual(stored());
});

it("predicts snapshot settings for a checkpointed meeting", async () => {
  seed({ ...base, checkpoint: {} });
  expect(await request()).toMatchObject({
    job: { settingsSource: "snapshot" },
  });
});

it("two simultaneous requests queue exactly one job", async () => {
  seed(base);
  const results = await Promise.all([request(), request()]);
  expect(results.map((result) => result.kind).sort()).toEqual([
    "conflict",
    "queued",
  ]);
});

it("replacing generated notes needs replaceNotes", async () => {
  seed({
    ...base,
    notes: "Generated synthetic notes",
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "generated",
    },
  });
  expect(await request()).toEqual({
    kind: "ineligible",
    reason: "replace_confirmation_required",
  });
  expect(stored()?.processingRetry).toBeUndefined();
  expect(await request({ replaceNotes: true })).toMatchObject({
    kind: "queued",
    job: { replaceNotes: true, transcriptSource: "mixed" },
  });
});

it("users stop at three counted attempts; the operator does not", async () => {
  seed({ ...base, processingRetry: failedJob });
  expect(await request()).toEqual({
    kind: "ineligible",
    reason: "attempts_exhausted",
  });
  expect(await request({ source: "operator" })).toMatchObject({
    kind: "queued",
    job: { countedAttempts: 3 },
  });
});

it("reports unavailable while the flag or index is off, and writes nothing", async () => {
  jest.mocked(isProcessingRetryAvailable).mockResolvedValue(false);
  seed(base);
  expect(await request()).toEqual({ kind: "unavailable" });
  expect(stored()?.processingRetry).toBeUndefined();
  expect(captureEvent).not.toHaveBeenCalled();
});

it("treats a meeting that disappeared as a conflict", async () => {
  expect(await request()).toEqual({ kind: "conflict" });
});

it("captures the requested event with shape-only properties", async () => {
  seed(base);
  await request();
  expect(captureEvent).toHaveBeenCalledTimes(1);
  expect(captureEvent).toHaveBeenCalledWith(
    "meeting_processing_retry_requested",
    {
      userId,
      guildId: key.guildId,
      properties: {
        stages: ["notes", "summary"],
        source: "portal",
        replace_notes: false,
        settings_source: "current",
      },
    },
  );
});
