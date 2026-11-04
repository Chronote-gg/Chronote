/** @jest-environment node */
import {
  allQueued,
  parseRetryProcessingArgs,
  queueRetries,
  runWithAnalyticsFlush,
  summarizeRetryCandidates,
} from "../../scripts/retry-meeting-processing";
import type {
  ProcessingRetryRequest,
  ProcessingRetryRequestResult,
} from "../../src/services/processingRetryRequestService";
import type { MeetingHistory } from "../../src/types/db";
import {
  PROCESSING_RETRY_USER_ATTEMPT_CAP,
  processingRetryJobSchema,
} from "../../src/types/meetingProcessingRetry";
import { history } from "../types/meetingUpdateDelivery.fixture";

const from = "2026-10-28T00:00:00.000Z";
const to = "2026-10-28T06:00:00.000Z";
const operator = "111111111111111111";
const window = ["--from", from, "--to", to];

const row = (
  index: number,
  patch: Partial<MeetingHistory>,
): MeetingHistory => ({
  ...history(),
  channelId_timestamp: `999999999999999991#2026-10-28T0${index}:00:00.000Z`,
  status: "complete",
  transcriptS3Key: "t/transcript.json",
  audioS3Key: "t/audio.mp3",
  notes: undefined,
  ...patch,
});
const keyOf = (meeting: MeetingHistory) => ({
  guildId: meeting.guildId,
  channelId_timestamp: meeting.channelId_timestamp,
});
const notesFailed = {
  transcription: "ready",
  notes: "failed",
  summary: "skipped",
} as const;

test("defaults to a dry run and requires window and operator", () => {
  expect(
    parseRetryProcessingArgs([...window, "--operator-user-id", operator]),
  ).toEqual({ from, to, operatorUserId: operator, apply: false });
  expect(
    parseRetryProcessingArgs([
      ...window,
      "--operator-user-id",
      operator,
      "--guild-id",
      "222222222222222222",
      "--apply",
    ]),
  ).toMatchObject({ guildId: "222222222222222222", apply: true });
  expect(() => parseRetryProcessingArgs(window)).toThrow();
  expect(() =>
    parseRetryProcessingArgs(["--from", from, "--operator-user-id", operator]),
  ).toThrow();
  expect(() =>
    parseRetryProcessingArgs([...window, "--operator-user-id", operator, "-x"]),
  ).toThrow();
});

test("rejects an inverted window and a malformed operator id", () => {
  expect(() =>
    parseRetryProcessingArgs([
      "--from",
      to,
      "--to",
      from,
      "--operator-user-id",
      operator,
    ]),
  ).toThrow();
  expect(() =>
    parseRetryProcessingArgs([
      "--from",
      "yesterday",
      "--to",
      to,
      "--operator-user-id",
      operator,
    ]),
  ).toThrow();
  expect(() =>
    parseRetryProcessingArgs([...window, "--operator-user-id", "12345"]),
  ).toThrow();
});

test("counts by stage set and skip reason, and never queues a notes replacement", () => {
  const notesRetry = row(1, { processing: notesFailed });
  const summaryRetry = row(2, {
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "failed",
    },
    notes: "Synthetic notes",
  });
  const replacement = row(3, {
    processing: notesFailed,
    notes: "Synthetic notes",
  });
  const healthy = row(4, {
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    notes: "Synthetic notes",
  });
  expect(
    summarizeRetryCandidates([notesRetry, summaryRetry, replacement, healthy]),
  ).toEqual({
    byStages: { "notes+summary": 1, summary: 1 },
    skipped: { replace_confirmation_required: 1, nothing_failed: 1 },
    queueable: [keyOf(notesRetry), keyOf(summaryRetry)],
    needsConfirmation: [keyOf(replacement)],
  });
});

const job = (status: "queued" | "failed", countedAttempts: number) =>
  processingRetryJobSchema.parse({
    jobId: "job-1",
    status,
    stages: ["notes", "summary"],
    requestedBy: "user-1",
    requestedAt: from,
    expectedNotesVersion: 1,
    replaceNotes: false,
    countedAttempts,
    settingsSource: "snapshot",
    transcriptSource: "existing",
    updatedAt: from,
  });

test("includes meetings over the user attempt cap", () => {
  const exhausted = row(1, {
    processing: notesFailed,
    processingRetry: job("failed", PROCESSING_RETRY_USER_ATTEMPT_CAP),
  });
  expect(summarizeRetryCandidates([exhausted]).queueable).toEqual([
    keyOf(exhausted),
  ]);
});

describe("apply", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test("tallies results by kind and fails when anything was not queued", async () => {
    const queued = row(1, {});
    const results: ProcessingRetryRequestResult[] = [
      { kind: "queued", history: queued, job: job("queued", 0) },
      { kind: "conflict" },
      { kind: "ineligible", reason: "notes_edited" },
    ];
    const requests: ProcessingRetryRequest[] = [];
    const tally = await queueRetries(
      [keyOf(queued), keyOf(row(2, {})), keyOf(row(3, {}))],
      operator,
      async (input) => {
        requests.push(input);
        return results[requests.length - 1];
      },
    );
    expect(tally).toEqual({ queued: 1, conflict: 1, ineligible: 1 });
    expect(allQueued(tally)).toBe(false);
    expect(allQueued({ queued: 2 })).toBe(true);
    expect(requests).toHaveLength(3);
    for (const request of requests)
      expect(request).toMatchObject({
        requestedBy: operator,
        replaceNotes: false,
        source: "operator",
      });
  });

  test("flushes analytics after success and after failure", async () => {
    const flush = jest.fn(async () => undefined);
    await expect(runWithAnalyticsFlush(async () => true, flush)).resolves.toBe(
      true,
    );
    await expect(runWithAnalyticsFlush(async () => false, flush)).resolves.toBe(
      false,
    );
    await expect(
      runWithAnalyticsFlush(async () => {
        throw new Error("synthetic");
      }, flush),
    ).resolves.toBe(false);
    expect(flush).toHaveBeenCalledTimes(3);
    await expect(
      runWithAnalyticsFlush(
        async () => true,
        async () => {
          throw new Error("synthetic flush");
        },
      ),
    ).resolves.toBe(false);
  });
});
