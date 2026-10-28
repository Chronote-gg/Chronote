/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/meetingRecoveryContent", () => ({
  ...jest.requireActual("../../src/services/meetingRecoveryContent"),
  readRecoveryContent: jest.fn(),
  retranscribeOmittedRanges: jest.fn(),
  recoveryNotesInput: jest.fn(),
}));
jest.mock("../../src/services/processingRetryTranscript", () => ({
  ...jest.requireActual("../../src/services/processingRetryTranscript"),
  transcribeMixedRecording: jest.fn(),
  storeRetryTranscript: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/meetingNotesService", () => ({
  ensureMeetingNotes: jest.fn(),
  ensureMeetingSummaries: jest.fn(),
}));
jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
}));
jest.mock("../../src/services/processingRetryNotesInput", () => ({
  buildCurrentNotesInput: jest.fn(),
  cleanupWithCurrentSettings: jest.fn(),
}));
jest.mock("../../src/services/recoveryTranscriptionProcessing", () => ({
  ...jest.requireActual("../../src/services/recoveryTranscriptionProcessing"),
  cleanupWithSavedSettings: jest.fn(),
}));
import {
  InvalidRecoveryContent,
  TranscriptOverlapUnknown,
  readRecoveryContent,
  recoveryNotesInput,
  retranscribeOmittedRanges,
  type RecoveryContent,
} from "../../src/services/meetingRecoveryContent";
import {
  storeRetryTranscript,
  transcribeMixedRecording,
  UNATTRIBUTED_TRANSCRIPT_NOTICE,
} from "../../src/services/processingRetryTranscript";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "../../src/services/meetingNotesService";
import { fetchJsonFromS3 } from "../../src/services/storageService";
import {
  buildCurrentNotesInput,
  cleanupWithCurrentSettings,
} from "../../src/services/processingRetryNotesInput";
import { cleanupWithSavedSettings } from "../../src/services/recoveryTranscriptionProcessing";
import {
  clearRetriedStages,
  runProcessingRetryStages,
} from "../../src/services/processingRetryStages";
import { z } from "zod";
import type { MeetingHistory } from "../../src/types/db";
import type { MeetingNotesInput } from "../../src/types/meeting-data";
import {
  processingRetryJobSchema,
  type ProcessingRetryJob,
} from "../../src/types/meetingProcessingRetry";

const iso = "2026-10-28T12:00:00.000Z";
const signal = new AbortController().signal;
const effect = <T>(run: () => Promise<T>) => run();
const reader = { read: jest.fn(), readVerifiedObject: jest.fn() };
const retryKey = "p/g/c_m_t/transcript-retry-job-1.json";
const checkpoint: NonNullable<MeetingHistory["checkpoint"]> = {
  artifactFolder: "p/g/c_m_t/",
  schemaVersion: 1,
  revision: 1,
  capture: {
    guildId: "guild-1",
    channelId: "voice-1",
    channelId_timestamp: `voice-1#${iso}`,
    meetingId: "meeting-1",
    ownerInstanceId: "owner",
    executionVersion: 1,
    reservedAt: iso,
    captureStartedAt: iso,
    requested: { transcribeMeeting: true, generateNotes: true },
  },
  manifest: {
    key: "p/g/c_m_t/manifest.json",
    byteLength: 1,
    checksumSha256: "sha",
  },
};
const base: MeetingHistory = {
  guildId: "guild-1",
  channelId_timestamp: `voice-1#${iso}`,
  meetingId: "meeting-1",
  channelId: "voice-1",
  timestamp: iso,
  participants: [],
  duration: 60,
  transcribeMeeting: true,
  generateNotes: true,
  transcriptS3Key: "p/g/c_m_t/transcript.json",
  processing: { transcription: "ready", notes: "failed", summary: "skipped" },
};
const failedTranscription: MeetingHistory = {
  ...base,
  transcriptS3Key: undefined,
  checkpoint,
  processing: { transcription: "failed", notes: "skipped", summary: "skipped" },
};
const job = (stages: ProcessingRetryJob["stages"]): ProcessingRetryJob =>
  processingRetryJobSchema.parse({
    jobId: "job-1",
    status: "running",
    stages,
    requestedBy: "user-1",
    requestedAt: iso,
    expectedNotesVersion: 1,
    replaceNotes: false,
    countedAttempts: 1,
    settingsSource: "snapshot",
    transcriptSource: stages.includes("transcription")
      ? "checkpoint"
      : "existing",
    updatedAt: iso,
  });
const RECOVERY_NOTICE = "Synthetic recovery capture notice";
const interrupted: MeetingHistory["capture"] = {
  kind: "interrupted",
  startedAt: iso,
  detectedAt: iso,
  endedAt: null,
};
const notesRetry = job(["notes", "summary"]);
const fullRetry = job(["transcription", "notes", "summary"]);
const content = {
  missing: [],
  context: { captureIncomplete: false },
} as unknown as RecoveryContent;
const notesInput = (): MeetingNotesInput => ({
  meetingId: "meeting-1",
  guildId: "guild-1",
  channelId: "voice-1",
  generateNotes: true,
  transcribeMeeting: true,
  startTime: new Date(iso),
  participants: new Map(),
  attendance: new Set(),
  creator: { id: "creator-1" },
  guild: { id: "guild-1", name: "Server X", description: null },
  voiceChannel: { id: "voice-1", name: "Channel Y" },
  processing: { transcription: "ready" },
});
const run = (history: MeetingHistory, retry = notesRetry) =>
  runProcessingRetryStages({ history, job: retry, signal, effect, reader });
const mixedAudioKey = "p/g/c_m_t/audio.mp3";
function unverifiableCheckpointWithNothingRetranscribed() {
  jest
    .mocked(readRecoveryContent)
    .mockResolvedValue({ ...content, missing: [{}] } as RecoveryContent);
  jest.mocked(retranscribeOmittedRanges).mockResolvedValue({
    text: "",
    segments: [],
    retranscribedRanges: 0,
  });
}
/** Runs a full retry that must end up transcribing the mixed recording. */
async function runMixedFallback(history: MeetingHistory = failedTranscription) {
  const result = await run(
    { ...history, audioS3Key: mixedAudioKey },
    fullRetry,
  );
  expect(transcribeMixedRecording).toHaveBeenCalledWith(mixedAudioKey, signal);
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(fetchJsonFromS3)
    .mockImplementation(async (key) =>
      key === base.transcriptS3Key ? { text: "Stored transcript" } : undefined,
    );
  jest.mocked(readRecoveryContent).mockResolvedValue(content);
  jest
    .mocked(recoveryNotesInput)
    .mockImplementation((_history, _content, transcript) => ({
      ...notesInput(),
      finalTranscript: transcript,
      recovered: true,
      captureNotice: RECOVERY_NOTICE,
    }));
  jest
    .mocked(buildCurrentNotesInput)
    .mockImplementation(async (_history, transcript) => ({
      ...notesInput(),
      finalTranscript: transcript,
    }));
  jest.mocked(retranscribeOmittedRanges).mockResolvedValue({
    text: "Recovered words.",
    segments: [{ userId: "123", startedAt: iso, text: "Recovered words." }],
    retranscribedRanges: 1,
  });
  jest
    .mocked(transcribeMixedRecording)
    .mockResolvedValue({ text: "Mixed words." });
  jest
    .mocked(cleanupWithSavedSettings)
    .mockImplementation(async (_content, text) => ({
      finalText: text,
      cleanup: "disabled",
    }));
  jest
    .mocked(cleanupWithCurrentSettings)
    .mockImplementation(async (_history, text) => text);
  jest.mocked(ensureMeetingNotes).mockImplementation(async (input) => {
    input.notesText = "Regenerated";
    input.processing = { ...input.processing, notes: "generated" };
    return input.notesText;
  });
  jest.mocked(ensureMeetingSummaries).mockImplementation(async (input) => {
    input.summarySentence = "Sentence";
    input.summaryLabel = "Label";
    input.processing = { ...input.processing, summary: "generated" };
    return { summarySentence: "Sentence", summaryLabel: "Label" };
  });
});

test("notes failure re-runs notes and summary from the stored transcript with frozen settings", async () => {
  const result = await run({ ...base, checkpoint });

  expect(result).toMatchObject({
    kind: "succeeded",
    settingsSource: "snapshot",
    transcriptSource: "existing",
    changes: {
      notes: "Regenerated",
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "generated",
      },
    },
  });
  expect(jest.mocked(ensureMeetingNotes).mock.calls[0][0]).toMatchObject({
    finalTranscript: "Stored transcript",
  });
});

test("clears copied notes and summary so the ensure functions regenerate them", () => {
  const input: Partial<MeetingNotesInput> = {
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "generated",
    },
    notesText: "old",
    summarySentence: "s",
    summaryLabel: "l",
  };
  const partialRow = {
    ...base,
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "generated",
    },
  } satisfies MeetingHistory;

  clearRetriedStages(
    input,
    partialRow,
    ["transcription", "notes", "summary"],
    "ready",
  );

  expect(input).toEqual({ processing: { transcription: "ready" } });
});

test("a summary-only retry keeps the stored notes as the summary source", async () => {
  const row: MeetingHistory = {
    ...base,
    notes: "Stored notes",
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "failed",
    },
  };

  const result = await run(row, job(["summary"]));

  expect(ensureMeetingNotes).not.toHaveBeenCalled();
  expect(ensureMeetingSummaries).toHaveBeenCalledWith(
    expect.anything(),
    "Stored notes",
  );
  expect(result).toMatchObject({
    kind: "succeeded",
    changes: { summarySentence: "Sentence", summaryLabel: "Label" },
  });
  expect(result.kind === "succeeded" && result.changes.notes).toBeFalsy();
});

test("an incomplete snapshot falls back to current settings and says so", async () => {
  jest.mocked(recoveryNotesInput).mockImplementation(() => {
    throw new InvalidRecoveryContent("Original generation inputs unavailable");
  });

  const result = await run({ ...base, checkpoint });

  expect(buildCurrentNotesInput).toHaveBeenCalled();
  expect(result).toMatchObject({
    kind: "succeeded",
    settingsSource: "current",
  });
});

test("a checkpoint transcription retry stores transcript-retry-<jobId>.json and keeps attribution", async () => {
  const result = await run(failedTranscription, fullRetry);

  expect(storeRetryTranscript).toHaveBeenCalledWith(
    retryKey,
    expect.objectContaining({
      text: "Recovered words.",
      segments: [expect.objectContaining({ userId: "123" })],
    }),
    signal,
  );
  expect(result).toMatchObject({
    kind: "succeeded",
    transcriptSource: "checkpoint",
    changes: {
      transcriptS3Key: retryKey,
      processing: { transcription: "ready" },
    },
  });
});

test("a checkpoint with no omitted ranges fails nothing_to_retry without generating notes", async () => {
  jest.mocked(retranscribeOmittedRanges).mockResolvedValue({
    text: "Saved words.",
    segments: [],
    retranscribedRanges: 0,
  });

  const result = await run(failedTranscription, fullRetry);

  expect(result).toMatchObject({ kind: "failed", reason: "nothing_to_retry" });
  expect(ensureMeetingNotes).not.toHaveBeenCalled();
  expect(storeRetryTranscript).not.toHaveBeenCalled();
});

test("a checkpoint with unverifiable audio and nothing re-transcribed falls back to mixed audio", async () => {
  unverifiableCheckpointWithNothingRetranscribed();

  const result = await runMixedFallback();
  expect(result).toMatchObject({
    kind: "succeeded",
    transcriptSource: "mixed",
  });
});

test("an interrupted capture keeps a successful checkpoint retry partial", async () => {
  const result = await run(
    {
      ...failedTranscription,
      capture: {
        kind: "interrupted",
        startedAt: iso,
        detectedAt: iso,
        endedAt: null,
      },
    },
    fullRetry,
  );

  expect(result).toMatchObject({
    kind: "succeeded",
    changes: { processing: { transcription: "partial" } },
  });
});

test("an unreadable checkpoint falls back to mixed audio", async () => {
  jest
    .mocked(readRecoveryContent)
    .mockRejectedValue(new InvalidRecoveryContent("corrupt"));

  const result = await runMixedFallback();
  expect(result).toMatchObject({
    kind: "succeeded",
    transcriptSource: "mixed",
    settingsSource: "current",
  });
});

test("a mixed-audio retry adds the unattributed notice", async () => {
  await run(
    {
      ...failedTranscription,
      checkpoint: undefined,
      audioS3Key: "p/g/c_m_t/audio.mp3",
    },
    fullRetry,
  );

  expect(jest.mocked(ensureMeetingNotes).mock.calls[0][0]).toMatchObject({
    captureNotice: UNATTRIBUTED_TRANSCRIPT_NOTICE,
    finalTranscript: "Mixed words.",
    processing: { transcription: "ready" },
  });
});

test("a re-claimed job reuses its stored retry transcript instead of transcribing again", async () => {
  jest.mocked(fetchJsonFromS3).mockImplementation(async (key) =>
    key === retryKey
      ? {
          text: "Earlier words.",
          segments: [{ userId: "123", startedAt: iso, text: "Earlier words." }],
        }
      : undefined,
  );

  const result = await run(failedTranscription, fullRetry);

  expect(retranscribeOmittedRanges).not.toHaveBeenCalled();
  expect(transcribeMixedRecording).not.toHaveBeenCalled();
  expect(storeRetryTranscript).not.toHaveBeenCalled();
  expect(jest.mocked(ensureMeetingNotes).mock.calls[0][0]).toMatchObject({
    finalTranscript: "Earlier words.",
  });
  expect(result).toMatchObject({
    kind: "succeeded",
    transcriptSource: "checkpoint",
    changes: { transcriptS3Key: retryKey },
  });
});

test.each([
  [
    "a failed notes outcome",
    "stage_failed",
    () =>
      jest.mocked(ensureMeetingNotes).mockImplementation(async (input) => {
        input.processing = { ...input.processing, notes: "failed" };
        return undefined;
      }),
    notesRetry,
    base,
  ],
  [
    "a provider error while re-transcribing",
    "stage_failed",
    () =>
      jest
        .mocked(retranscribeOmittedRanges)
        .mockRejectedValue(new Error("provider down")),
    fullRetry,
    failedTranscription,
  ],
  [
    "a missing mixed recording",
    "source_missing",
    () =>
      jest.mocked(transcribeMixedRecording).mockResolvedValue("source_missing"),
    fullRetry,
    { ...failedTranscription, checkpoint: undefined, audioS3Key: "p/a.mp3" },
  ],
  [
    "an unreadable checkpoint without a recording",
    "invalid_snapshot",
    () =>
      jest
        .mocked(readRecoveryContent)
        .mockRejectedValue(new InvalidRecoveryContent("corrupt")),
    fullRetry,
    failedTranscription,
  ],
  [
    "a missing stored transcript",
    "source_missing",
    () => jest.mocked(fetchJsonFromS3).mockResolvedValue(undefined),
    notesRetry,
    base,
  ],
] as const)(
  "fails with %s and returns no changes",
  async (_name, reason, arrange, retry, history) => {
    arrange();

    const result = await run(history, retry);

    expect(result).toEqual({
      kind: "failed",
      reason,
      settingsSource: expect.any(String),
      transcriptSource: expect.any(String),
    });
  },
);

test("a summary that names an unnamed meeting returns the rename", async () => {
  jest.mocked(ensureMeetingSummaries).mockImplementation(async (input) => {
    input.summarySentence = "Sentence";
    input.summaryLabel = "Planning";
    input.meetingName = "Planning";
    input.processing = { ...input.processing, summary: "generated" };
    return { summarySentence: "Sentence", summaryLabel: "Planning" };
  });

  const result = await run(base);

  expect(result.kind === "succeeded" && result.changes.meetingName).toBe(
    "Planning",
  );
});

test("an aborted run rethrows instead of reporting a failure", async () => {
  const controller = new AbortController();
  jest.mocked(ensureMeetingNotes).mockImplementation(async () => {
    controller.abort();
    throw new Error("aborted");
  });

  await expect(
    runProcessingRetryStages({
      history: base,
      job: notesRetry,
      signal: controller.signal,
      effect,
      reader,
    }),
  ).rejects.toBeDefined();
});

test("a snapshot retry drops the recovered flag so an unnamed meeting can be named", async () => {
  await run({ ...base, checkpoint, meetingName: undefined });

  expect(
    jest.mocked(ensureMeetingSummaries).mock.calls[0][0].recovered,
  ).toBeUndefined();
});

test.each([
  ["a completed capture", undefined, undefined],
  ["an interrupted capture", interrupted, RECOVERY_NOTICE],
] as const)(
  "a snapshot retry of %s carries the recovery notice only when interrupted",
  async (_name, capture, notice) => {
    await run({ ...base, checkpoint, capture });

    expect(jest.mocked(ensureMeetingNotes).mock.calls[0][0].captureNotice).toBe(
      notice,
    );
  },
);

test("a mixed fallback on an interrupted capture carries both notices and stays partial", async () => {
  jest
    .mocked(retranscribeOmittedRanges)
    .mockRejectedValue(new TranscriptOverlapUnknown("overlap"));

  const result = await run(
    {
      ...failedTranscription,
      capture: interrupted,
      audioS3Key: "p/g/c_m_t/audio.mp3",
    },
    fullRetry,
  );

  expect(result).toMatchObject({
    kind: "succeeded",
    transcriptSource: "mixed",
    settingsSource: "snapshot",
    changes: { processing: { transcription: "partial" } },
  });
  expect(jest.mocked(ensureMeetingNotes).mock.calls[0][0].captureNotice).toBe(
    `${RECOVERY_NOTICE}\n\n${UNATTRIBUTED_TRANSCRIPT_NOTICE}`,
  );
});

test("a parse error from re-transcription fails the stage instead of falling back", async () => {
  jest.mocked(retranscribeOmittedRanges).mockRejectedValue(new z.ZodError([]));

  const result = await run(
    { ...failedTranscription, audioS3Key: "p/g/c_m_t/audio.mp3" },
    fullRetry,
  );

  expect(result).toMatchObject({ kind: "failed", reason: "stage_failed" });
  expect(transcribeMixedRecording).not.toHaveBeenCalled();
});

describe("mixed-audio cleanup", () => {
  test("a readable checkpoint cleans the mixed transcript with the saved settings", async () => {
    unverifiableCheckpointWithNothingRetranscribed();
    jest.mocked(cleanupWithSavedSettings).mockResolvedValue({
      finalText: "Cleaned mixed words.",
      cleanup: "acknowledged",
    });

    await runMixedFallback();

    expect(cleanupWithSavedSettings).toHaveBeenCalledWith(
      expect.objectContaining({ missing: [{}] }),
      "Mixed words.",
      signal,
    );
    expect(cleanupWithCurrentSettings).not.toHaveBeenCalled();
    expect(jest.mocked(storeRetryTranscript).mock.calls[0][1].text).toBe(
      "Cleaned mixed words.",
    );
    expect(jest.mocked(ensureMeetingNotes).mock.calls[0][0]).toMatchObject({
      finalTranscript: "Cleaned mixed words.",
    });
  });

  test("without a readable checkpoint the mixed transcript is cleaned with current settings", async () => {
    jest
      .mocked(readRecoveryContent)
      .mockRejectedValue(new InvalidRecoveryContent("corrupt"));
    jest
      .mocked(cleanupWithCurrentSettings)
      .mockResolvedValue("Currently cleaned words.");

    await runMixedFallback();

    expect(cleanupWithSavedSettings).not.toHaveBeenCalled();
    expect(cleanupWithCurrentSettings).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: "meeting-1" }),
      "Mixed words.",
      signal,
    );
    expect(jest.mocked(ensureMeetingNotes).mock.calls[0][0]).toMatchObject({
      finalTranscript: "Currently cleaned words.",
    });
  });

  test("saved cleanup inputs that cannot be used fall back to current settings", async () => {
    jest
      .mocked(retranscribeOmittedRanges)
      .mockRejectedValue(new TranscriptOverlapUnknown("overlap"));
    jest
      .mocked(cleanupWithSavedSettings)
      .mockRejectedValue(
        new InvalidRecoveryContent("Original cleanup inputs unavailable"),
      );
    jest
      .mocked(cleanupWithCurrentSettings)
      .mockResolvedValue("Currently cleaned words.");

    const result = await runMixedFallback();

    expect(cleanupWithCurrentSettings).toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "succeeded",
      transcriptSource: "mixed",
    });
  });
});
