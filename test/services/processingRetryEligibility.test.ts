import type { MeetingHistory } from "../../src/types/db";
import {
  processingRetryJobSchema,
  type ProcessingRetryJob,
} from "../../src/types/meetingProcessingRetry";
import {
  getProcessingRetryEligibility,
  notesEditedByPerson,
  projectProcessingRetry,
} from "../../src/services/processingRetryEligibility";
import { history } from "../types/meetingUpdateDelivery.fixture";

const iso = "2026-10-28T12:00:00.000Z";
const generatedNotes = "Generated synthetic notes";
const pointer = {};
const failedNotes = {
  transcription: "ready",
  notes: "failed",
  summary: "skipped",
} as const;
const partialNotes = {
  transcription: "partial",
  notes: "generated",
  summary: "generated",
} as const;
const base: MeetingHistory = {
  ...history(),
  status: "complete",
  transcriptS3Key: "t/transcript.json",
  audioS3Key: "t/audio.mp3",
  notes: undefined,
};
const job = (patch: Partial<ProcessingRetryJob>): ProcessingRetryJob =>
  processingRetryJobSchema.parse({
    jobId: "job-1",
    status: "queued",
    stages: ["notes", "summary"],
    requestedBy: "user-1",
    requestedAt: iso,
    expectedNotesVersion: 1,
    replaceNotes: false,
    countedAttempts: 1,
    settingsSource: "snapshot",
    transcriptSource: "existing",
    updatedAt: iso,
    ...patch,
  });
const eligibility = (patch: object, actor?: "portal" | "operator") =>
  getProcessingRetryEligibility({ ...base, ...patch }, actor);

test.each([
  [
    "transcription failed with checkpoint",
    {
      processing: {
        transcription: "failed",
        notes: "skipped",
        summary: "skipped",
      },
      checkpoint: pointer,
    },
    ["transcription", "notes", "summary"],
    "checkpoint",
  ],
  [
    "transcription failed without checkpoint",
    { processing: { transcription: "failed", notes: "skipped" } },
    ["transcription", "notes", "summary"],
    "mixed",
  ],
  [
    "notes failed",
    {
      processing: {
        transcription: "ready",
        notes: "failed",
        summary: "skipped",
      },
      notes: undefined,
    },
    ["notes", "summary"],
    "existing",
  ],
  [
    "summary failed only",
    {
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "failed",
      },
      notes: generatedNotes,
    },
    ["summary"],
    "existing",
  ],
  [
    "notes failed without a usable transcript",
    {
      processing: { transcription: "ready", notes: "failed" },
      transcriptS3Key: undefined,
    },
    ["transcription", "notes", "summary"],
    "mixed",
  ],
])("%s selects its stages", (_, patch, stages, transcriptSource) => {
  expect(eligibility(patch)).toEqual({
    eligible: true,
    stages,
    transcriptSource,
    requiresReplaceConfirm: false,
  });
});

test("partial transcript with generated notes requires replace confirmation", () => {
  expect(
    eligibility({ processing: partialNotes, notes: generatedNotes }),
  ).toEqual({
    eligible: true,
    stages: ["transcription", "notes", "summary"],
    transcriptSource: "mixed",
    requiresReplaceConfirm: true,
  });
});

test("a partial transcript with another failure still retries that failure", () => {
  expect(
    eligibility({
      processing: { ...failedNotes, transcription: "partial" },
      processingRetry: job({ status: "succeeded" }),
    }),
  ).toMatchObject({ eligible: true, stages: ["notes", "summary"] });
});

test.each([
  ["personal_meeting", { ownershipScope: "personal" }],
  ["processing_in_progress", { status: "processing" }],
  [
    "processing_in_progress",
    { processing: failedNotes, recovery: { disposition: "pending" } },
  ],
  ["no_processing_record", { processing: undefined }],
  [
    "nothing_failed",
    { processing: { transcription: "empty", notes: "skipped" } },
  ],
  [
    "job_active",
    { processing: failedNotes, processingRetry: job({ status: "queued" }) },
  ],
  [
    "job_active",
    { processing: failedNotes, processingRetry: job({ status: "running" }) },
  ],
  [
    "capture_incomplete",
    {
      processing: partialNotes,
      processingRetry: job({
        status: "failed",
        failureReason: "nothing_to_retry",
      }),
    },
  ],
  [
    "capture_incomplete",
    { processing: partialNotes, processingRetry: job({ status: "succeeded" }) },
  ],
  [
    "source_missing",
    { processing: { transcription: "failed" }, audioS3Key: undefined },
  ],
  [
    "source_missing",
    {
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "failed",
      },
      notes: " ",
    },
  ],
  [
    "attempts_exhausted",
    {
      processing: failedNotes,
      processingRetry: job({ status: "failed", countedAttempts: 3 }),
    },
  ],
  [
    "notes_edited",
    {
      processing: partialNotes,
      notes: generatedNotes,
      notesVersion: 2,
      notesHistory: [
        {
          version: 2,
          notes: "x",
          editedBy: "u",
          editedAt: iso,
          source: { type: "web_editor" },
        },
      ],
    },
  ],
])("is not eligible: %s", (reason, patch) => {
  expect(eligibility(patch)).toEqual({ eligible: false, reason });
});

test("the operator bypasses only the attempt cap", () => {
  expect(
    eligibility(
      {
        processing: failedNotes,
        processingRetry: job({ status: "failed", countedAttempts: 3 }),
      },
      "operator",
    ),
  ).toMatchObject({ eligible: true });
  expect(
    eligibility(
      {
        processing: partialNotes,
        notes: generatedNotes,
        notesVersion: 2,
        notesHistory: [
          { version: 2, notes: "x", editedBy: "u", editedAt: iso },
        ],
      },
      "operator",
    ),
  ).toEqual({ eligible: false, reason: "notes_edited" });
});

test.each([
  [undefined, [], false],
  [1, [], false],
  [
    2,
    [{ version: 2, source: { type: "processing_retry", jobId: "j" } }],
    false,
  ],
  [2, [{ version: 2 }], true],
  [2, [{ version: 2, source: { type: "web_editor" } }], true],
  [3, [{ version: 3, source: { type: "processing_retry", jobId: "j" } }], true],
])(
  "notesVersion %p with history %j is person-edited: %p",
  (notesVersion, entries, expected) => {
    expect(
      notesEditedByPerson({
        notesVersion,
        notesHistory: entries.map((e) => ({
          notes: "n",
          editedBy: "u",
          editedAt: iso,
          ...e,
        })),
      }),
    ).toBe(expected);
  },
);

test("projection reports remaining attempts and an external block", () => {
  const row = {
    ...base,
    processing: failedNotes,
    processingRetry: job({
      status: "failed",
      failureReason: "stage_failed",
      countedAttempts: 2,
      settingsSource: "current",
    }),
  };
  expect(projectProcessingRetry(row)).toEqual({
    eligible: true,
    requiresReplaceConfirm: false,
    status: "failed",
    failureReason: "stage_failed",
    settingsSource: "current",
    attemptsRemaining: 1,
  });
  expect(projectProcessingRetry(row, "unavailable")).toMatchObject({
    eligible: false,
    reason: "unavailable",
  });
});

test("projection reports the ineligible reason and never negative attempts", () => {
  expect(
    projectProcessingRetry({
      ...base,
      processing: failedNotes,
      processingRetry: job({ status: "failed", countedAttempts: 4 }),
    }),
  ).toEqual({
    eligible: false,
    reason: "attempts_exhausted",
    requiresReplaceConfirm: false,
    status: "failed",
    settingsSource: "snapshot",
    attemptsRemaining: 0,
  });
});
