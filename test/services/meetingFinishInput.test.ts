/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeContentSnippet: jest.fn(async () => ({
    status: "succeeded",
    text: "Recovered discussion.",
  })),
}));
jest.mock("../../src/services/mixedPcmService", () => ({
  renderMixedPcmTracks: jest.fn(async (_tracks: unknown, output: string) => {
    await jest
      .requireActual<typeof import("node:fs")>("node:fs")
      .promises.writeFile(output, "mp3");
    return output;
  }),
}));
jest.mock("../../src/services/storageService", () => ({
  ...jest.requireActual("../../src/services/storageService"),
  fetchJsonFromS3: jest.fn(),
}));
jest.mock("../../src/services/meetingCaptureWrapUp", () => ({
  settleCapturedAudio: jest.fn(async () => undefined),
  resolveMeetingCancellation: jest.fn(async () => ({ kind: "proceed" })),
  buildMeetingRecording: jest.fn(async () => "synthetic/mixed.mp3"),
  compileFinalTranscript: jest.fn(
    async (
      meeting: { finalTranscript?: string; processing?: object },
      compile: (options: object) => Promise<string>,
    ) => {
      meeting.finalTranscript = await compile({});
      meeting.processing = { transcription: "ready" };
    },
  ),
  compileTranscriptForUpload: jest.fn(
    (_meeting: unknown, compile: (options: object) => Promise<string>) =>
      compile({ includeCues: true }),
  ),
  compileCancelledTranscript: jest.fn(async () => "Cancelled transcript."),
  captionMeetingImagesStep: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/autoRecordCancellationService", () => ({
  ...jest.requireActual("../../src/services/autoRecordCancellationService"),
  decideAutoRecordCancellation: jest.fn(async () => ({ cancel: false })),
}));
jest.mock("../../src/services/transcriptCompilationService", () => ({
  createMeetingTranscriptCompiler: jest.fn(),
}));
jest.mock("../../src/services/notesPromptService", () => ({
  ...jest.requireActual("../../src/services/notesPromptService"),
  prepareLiveNotesPrompt: jest.fn(async () => ({
    messages: [],
    source: "langfuse",
  })),
}));
import { promises as fs } from "node:fs";
import type { Client } from "discord.js";
import { transcribeContentSnippet } from "../../src/services/transcriptionService";
import { renderMixedPcmTracks } from "../../src/services/mixedPcmService";
import { fetchJsonFromS3 } from "../../src/services/storageService";
import { createMeetingTranscriptCompiler } from "../../src/services/transcriptCompilationService";
import {
  compileFinalTranscript,
  compileTranscriptForUpload,
} from "../../src/services/meetingCaptureWrapUp";
import {
  CHECKPOINT_VERIFICATION_CONCURRENCY,
  createRecordingCheckpointService,
} from "../../src/services/recordingCheckpointService";
import {
  loadNormalFinishInput,
  loadRecoveryFinishInput,
  type FinishInput,
} from "../../src/services/meetingFinishInput";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
import { history } from "../fixtures/meetingHistory";
import {
  pcmArtifact,
  recoveryFixture,
  savedTranscriptionPrompt,
} from "./meetingRecoveryFixtures";
import {
  INTERRUPTED_CAPTURE_NOTICE,
  readRecoveryContent,
} from "../../src/services/meetingRecoveryContent";
import { summarizeCaptureCoverage } from "../../src/utils/meetingCaptureNotice";
import type { CompletionPolicy } from "../../src/types/meetingCompletionPolicy";
import type { RecordingCaptureState } from "../../src/types/recordingCheckpoint";
import { decideAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import * as openaiText from "../../src/services/openaiTextService";
import type { generateOpenAIText } from "../../src/services/openaiTextService";

const cancelledPolicy: CompletionPolicy = {
  policy: {
    enabled: true,
    maximumSeconds: 90,
    maximumWords: 50,
    maximumChatMessages: 1,
    dismissedMinimumMilliseconds: 600_000,
    dismissedMinimumChatMessages: 2,
  },
  isAutoRecording: true,
  chatMessageCount: 0,
  dismissed: false,
  decision: "cancel",
};

const PIECE_BYTES = 3840;
const PIECE_MS = 20;
const LARGE_MANIFEST_PIECES = 240;
const SAVED_TEXT = "We agreed to finish the release testing tomorrow.";

const signal = () => new AbortController().signal;
const created: FinishInput[] = [];
afterEach(async () => {
  for (const input of created.splice(0))
    if (input.localDirectory)
      await fs.rm(input.localDirectory, { recursive: true, force: true });
});
beforeEach(() => jest.clearAllMocks());

function pieces(count: number, sourceId = "user:123") {
  return Array.from({ length: count }, (_, sequence) =>
    pcmArtifact(sourceId, sequence, Buffer.alloc(PIECE_BYTES, sequence + 1), [
      { startOffsetMs: sequence * PIECE_MS, durationMs: PIECE_MS },
    ]),
  );
}

/** Saved entry for piece 1 of three; pieces 0 and 2 have no transcript yet. */
function savedMiddlePiece(text = SAVED_TEXT) {
  return recoveryFixture(text, {
    context: savedTranscriptionPrompt,
    artifacts: pieces(3),
    transcript: (saved) => {
      saved.entries[0].correspondence = {
        kind: "pcm",
        spans: [
          {
            sourceId: "user:123",
            sequence: 1,
            startByte: 0,
            endByte: PIECE_BYTES,
          },
        ],
      };
    },
  });
}

async function track(input: Promise<FinishInput>) {
  const value = await input;
  created.push(value);
  return value;
}

test("recovery loader with no manifest reports no saved audio", async () => {
  const input = await track(
    loadRecoveryFinishInput({ ...history }, signal(), {
      read: jest.fn(),
      readVerifiedObject: jest.fn(),
    }),
  );
  expect(input).toMatchObject({
    source: "recovery",
    hasSavedAudio: false,
    transcript: "",
  });
  expect(input.transcriptUpload).toBeUndefined();
  expect(input.recordingPath).toBeUndefined();
});

test("recovery loader with no verified audio reports no saved audio", async () => {
  const f = await recoveryFixture(SAVED_TEXT);
  const input = await track(
    loadRecoveryFinishInput(f.claim.history, signal(), f.reader),
  );
  expect(input.hasSavedAudio).toBe(false);
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
});

describe("a capture its checkpoint proves ended complete, with no saved audio, is an empty recording", () => {
  const completeEnd = {
    kind: "complete" as const,
    startedAt: history.timestamp,
    endedAt: history.timestamp,
  };
  const undecided: CompletionPolicy = {
    ...cancelledPolicy,
    elapsedMilliseconds: 30_000,
    decision: "undecided",
  };
  async function recoverSilent(
    overrides: Partial<MeetingHistory> = {},
    requested?: { transcribeMeeting: boolean; generateNotes: boolean },
    manifestEnd: RecordingCaptureState = completeEnd,
  ) {
    const f = await recoveryFixture(SAVED_TEXT, {
      requested,
      captureState: manifestEnd,
    });
    return track(
      loadRecoveryFinishInput(
        { ...f.claim.history, capture: completeEnd, ...overrides },
        signal(),
        f.reader,
      ),
    );
  }

  test("a manual recording counts its audio as saved and its transcript as empty", async () => {
    const input = await recoverSilent();
    expect(input).toMatchObject({
      source: "recovery",
      hasSavedAudio: true,
      transcript: "",
      processing: { transcription: "empty" },
    });
    expect(input.notesInput.processing).toEqual({ transcription: "empty" });
    expect(input.cancel).toBeUndefined();
    expect(input.recordingPath).toBeUndefined();
    expect(input.transcriptUpload).toBeUndefined();
    expect(transcribeContentSnippet).not.toHaveBeenCalled();
    expect(decideAutoRecordCancellation).not.toHaveBeenCalled();
  });

  // A completed final flush always publishes a manifest that records the capture as complete;
  // without one the row's complete capture end does not prove that nobody spoke.
  test("a complete row with no checkpoint at all still fails silently", async () => {
    const input = await track(
      loadRecoveryFinishInput({ ...history, capture: completeEnd }, signal(), {
        read: jest.fn(),
        readVerifiedObject: jest.fn(),
      }),
    );
    expect(input).toMatchObject({ hasSavedAudio: false, processing: {} });
  });

  test("a complete row whose manifest does not record a complete capture still fails silently", async () => {
    const input = await recoverSilent({}, undefined, {
      kind: "capturing",
      startedAt: history.timestamp,
    });
    expect(input).toMatchObject({ hasSavedAudio: false, processing: {} });
    expect(decideAutoRecordCancellation).not.toHaveBeenCalled();
  });

  test("a recording that asked for no transcription records no outcome", async () => {
    const input = await recoverSilent(
      {},
      { transcribeMeeting: false, generateNotes: false },
    );
    expect(input.hasSavedAudio).toBe(true);
    expect(input.processing).toEqual({});
  });

  test("a stored cancel still cancels", async () => {
    const input = await recoverSilent({
      isAutoRecording: true,
      completionPolicy: cancelledPolicy,
    });
    expect(input.hasSavedAudio).toBe(true);
    expect(input.cancel).toEqual({});
    expect(decideAutoRecordCancellation).not.toHaveBeenCalled();
  });

  test.each([
    { verdict: { cancel: true, reason: "Synthetic reason" }, cancel: true },
    { verdict: { cancel: false }, cancel: false },
  ])(
    "an undecided auto-recording is evaluated over zero words, as the normal path does (cancel: $cancel)",
    async ({ verdict, cancel }) => {
      jest.mocked(decideAutoRecordCancellation).mockResolvedValueOnce(verdict);
      const input = await recoverSilent({
        isAutoRecording: true,
        completionPolicy: undecided,
      });
      expect(decideAutoRecordCancellation).toHaveBeenCalledTimes(1);
      const facts = jest.mocked(decideAutoRecordCancellation).mock.calls[0][0];
      await expect(facts.content()).resolves.toEqual({
        transcriptText: "",
        chatLines: [],
      });
      expect(input.hasSavedAudio).toBe(true);
      expect(input.cancel).toEqual(
        cancel ? { reason: "Synthetic reason" } : undefined,
      );
    },
  );

  test("an interrupted capture with no saved audio still fails silently", async () => {
    const input = await recoverSilent({
      capture: {
        kind: "interrupted",
        startedAt: history.timestamp,
        detectedAt: history.timestamp,
        endedAt: null,
      },
    });
    expect(input).toMatchObject({ hasSavedAudio: false, processing: {} });
  });
});

test("recovery loader transcribes only untranscribed pieces", async () => {
  const f = await savedMiddlePiece();
  const input = await track(
    loadRecoveryFinishInput(f.claim.history, signal(), f.reader),
  );
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(2);
  expect(
    jest
      .mocked(transcribeContentSnippet)
      .mock.calls.map(([, snippet]) => snippet.chunks[0][0]),
  ).toEqual([1, 3]);
  expect(input.hasSavedAudio).toBe(true);
  expect(input.transcript).toContain(SAVED_TEXT);
  expect(input.transcript).toContain("Recovered discussion.");
  expect(input.notesInput.finalTranscript).toBe(input.transcript);
  expect(input.processing.transcription).toBe("partial");
  expect(input.transcriptUpload?.key).toBe(
    `${f.claim.history.checkpoint!.artifactFolder}transcript.json`,
  );
  expect(input.recordingPath).toBeDefined();
  expect(input.localDirectory).toBeDefined();
  expect(input.recordingPath!.startsWith(input.localDirectory!)).toBe(true);
  await expect(fs.readFile(input.recordingPath!, "utf8")).resolves.toBe("mp3");
});

test("recovery loader reuses a recorded transcript and omits its upload", async () => {
  const f = await savedMiddlePiece();
  const key = `${f.claim.history.checkpoint!.artifactFolder}transcript.json`;
  jest.mocked(fetchJsonFromS3).mockResolvedValueOnce({
    text: "Stored transcript.",
  });
  const input = await track(
    loadRecoveryFinishInput(
      { ...f.claim.history, transcriptS3Key: key },
      signal(),
      f.reader,
    ),
  );
  expect(fetchJsonFromS3).toHaveBeenCalledWith(key, expect.anything());
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
  expect(input.transcript).toBe("Stored transcript.");
  expect(input.transcriptUpload).toBeUndefined();
});

test("recovery loader reads a 240 piece manifest with bounded concurrency", async () => {
  const f = await recoveryFixture("", {
    context: savedTranscriptionPrompt,
    artifacts: pieces(LARGE_MANIFEST_PIECES),
    transcript: (saved) => {
      saved.entries = [];
    },
  });
  let inFlight = 0;
  let observedMaximum = 0;
  const reader = createRecordingCheckpointService({
    repository: f.repository,
    objects: {
      upload: f.upload,
      read: async (key) => {
        inFlight += 1;
        observedMaximum = Math.max(observedMaximum, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return f.objects.get(key);
      },
    },
  });
  const input = await track(
    loadRecoveryFinishInput(f.claim.history, signal(), reader),
  );
  expect(input.hasSavedAudio).toBe(true);
  // The checkpoint service verifies pieces in batches; transcription and the
  // mix read one piece at a time, so the batch size is the observed maximum.
  expect(observedMaximum).toBe(CHECKPOINT_VERIFICATION_CONCURRENCY);
});

test("an aborted signal stops the recovery loader between stages", async () => {
  const f = await savedMiddlePiece();
  const controller = new AbortController();
  const reader = {
    ...f.reader,
    read: async (...args: Parameters<typeof f.reader.read>) => {
      const result = await f.reader.read(...args);
      controller.abort(new Error("Synthetic shutdown"));
      return result;
    },
  };
  await expect(
    loadRecoveryFinishInput(f.claim.history, controller.signal, reader),
  ).rejects.toThrow("Synthetic shutdown");
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
  expect(renderMixedPcmTracks).not.toHaveBeenCalled();
});

function normalMeeting(transcript: string): MeetingData {
  const startTime = new Date(history.timestamp);
  const participant = { id: "123", username: "Speaker" };
  const value = {
    meetingId: history.meetingId,
    guildId: history.guildId,
    channelId: history.channelId,
    transcribeMeeting: true,
    generateNotes: true,
    startTime,
    tags: [],
    participants: new Map([[participant.id, participant]]),
    attendance: new Set(["<@123>"]),
    creator: { id: "123" },
    guild: {
      id: history.guildId,
      name: "Saved server",
      description: "Saved description",
    },
    voiceChannel: { id: history.channelId, name: "Saved channel" },
    audioData: {
      audioFiles: [
        {
          userId: "123",
          timestamp: startTime.getTime(),
          transcript,
          processing: false,
          audioOnlyProcessing: false,
        },
      ],
    },
    chatLog: [],
  };
  return value as unknown as MeetingData;
}

test("normal loader reuses the in-memory compile", async () => {
  const compile = jest.fn(async (options: { includeCues?: boolean }) =>
    options.includeCues ? "With cues." : "Final transcript.",
  );
  jest.mocked(createMeetingTranscriptCompiler).mockReturnValue(compile);
  const meeting = normalMeeting("Final transcript.");
  const client = {} as Client;
  const input = await loadNormalFinishInput(meeting, client, signal());
  expect(createMeetingTranscriptCompiler).toHaveBeenCalledTimes(1);
  expect(createMeetingTranscriptCompiler).toHaveBeenCalledWith(client, meeting);
  expect(jest.mocked(compileFinalTranscript).mock.calls[0][1]).toBe(compile);
  expect(jest.mocked(compileTranscriptForUpload).mock.calls[0][1]).toBe(
    compile,
  );
  expect(input).toMatchObject({
    source: "normal",
    transcript: "With cues.",
    processing: { transcription: "ready" },
    hasSavedAudio: true,
    recordingPath: "synthetic/mixed.mp3",
    chatEntries: [],
  });
  expect(input.notesInput.finalTranscript).toBe("Final transcript.");
  expect(input.notesInput.notesPrompt).toBeDefined();
  expect(input.transcriptUpload?.key).toMatch(/transcript\.json$/);
  expect(JSON.parse(input.transcriptUpload!.body.toString("utf8")).text).toBe(
    "With cues.",
  );
});

const MEETING_NAME = "Synthetic planning";
const completeCapture = {
  kind: "complete" as const,
  startedAt: history.timestamp,
  endedAt: history.timestamp,
};
const interruptedCaptureState = {
  kind: "interrupted" as const,
  startedAt: history.timestamp,
  detectedAt: history.timestamp,
  endedAt: null,
};

function singleUntranscribedPiece() {
  return recoveryFixture("", {
    context: savedTranscriptionPrompt,
    artifacts: pieces(1),
    transcript: (saved) => {
      saved.entries = [];
    },
  });
}

test("normal and recovery loaders produce the same notes input for the same meeting content", async () => {
  const f = await singleUntranscribedPiece();
  const recovered = await track(
    loadRecoveryFinishInput(
      {
        ...f.claim.history,
        capture: completeCapture,
        meetingName: MEETING_NAME,
      },
      signal(),
      f.reader,
    ),
  );
  jest
    .mocked(createMeetingTranscriptCompiler)
    .mockReturnValue(jest.fn(async () => recovered.transcript));
  const meeting = normalMeeting(recovered.transcript);
  meeting.meetingName = MEETING_NAME;
  const normal = await loadNormalFinishInput(meeting, {} as Client, signal());
  const shared = (input: FinishInput) => ({
    meetingId: input.notesInput.meetingId,
    guildId: input.notesInput.guildId,
    channelId: input.notesInput.channelId,
    transcribeMeeting: input.notesInput.transcribeMeeting,
    generateNotes: input.notesInput.generateNotes,
    startTime: input.notesInput.startTime,
    finalTranscript: input.notesInput.finalTranscript,
    tags: input.notesInput.tags,
    participants: input.notesInput.participants,
    attendance: input.notesInput.attendance,
    creator: input.notesInput.creator,
    guild: input.notesInput.guild,
    voiceChannel: input.notesInput.voiceChannel,
    meetingName: input.notesInput.meetingName,
    recovered: input.notesInput.recovered,
    captureNotice: input.notesInput.captureNotice,
    hasNotesPrompt: Boolean(input.notesInput.notesPrompt),
    participantList: input.participants,
  });
  expect(shared(recovered)).toMatchObject({
    meetingName: MEETING_NAME,
    recovered: undefined,
    captureNotice: undefined,
    hasNotesPrompt: true,
  });
  expect(shared(normal)).toEqual(shared(recovered));
});

test("an interrupted capture keeps the capture notice in the recovery notes input", async () => {
  const f = await singleUntranscribedPiece();
  const input = await track(
    loadRecoveryFinishInput(
      {
        ...f.claim.history,
        capture: interruptedCaptureState,
        meetingName: MEETING_NAME,
      },
      signal(),
      f.reader,
    ),
  );
  expect(input.notesInput.captureNotice).toContain(INTERRUPTED_CAPTURE_NOTICE);
  expect(input.notesInput.recovered).toBeUndefined();
  expect(input.notesInput.meetingName).toBe(MEETING_NAME);
  expect(input.processing.transcription).toBe("partial");
  expect(input.captureCoverage).toEqual(
    summarizeCaptureCoverage(
      (await readRecoveryContent(f.claim.history, f.reader, signal())).coverage,
    ),
  );
  expect(input.captureCoverage?.kind).toBe("verified");
});

const withoutSavedPrompts = (
  saved: Parameters<typeof savedTranscriptionPrompt>[0],
) => {
  savedTranscriptionPrompt(saved);
  saved.prompts.notes = { availability: "unavailable" };
  saved.prompts.summary = { availability: "unavailable" };
};

test.each([
  {
    name: "cancelled",
    requested: { transcribeMeeting: true, generateNotes: true },
    completionPolicy: true,
    text: "",
    expected: { cancel: {}, processing: {} },
  },
  {
    name: "transcription off",
    requested: { transcribeMeeting: false, generateNotes: false },
    completionPolicy: false,
    text: "",
    expected: { processing: {} },
  },
  {
    name: "notes off",
    requested: { transcribeMeeting: true, generateNotes: false },
    completionPolicy: false,
    text: "Recovered discussion.",
    expected: { processing: { transcription: "ready" } },
  },
  {
    name: "empty transcript",
    requested: { transcribeMeeting: true, generateNotes: true },
    completionPolicy: false,
    text: "",
    expected: { processing: { transcription: "empty" } },
  },
])(
  "recovery loader with unavailable saved prompts loads a $name meeting",
  async ({ name, requested, completionPolicy, text, expected }) => {
    // Speech the gate rejects comes back as empty text.
    if (name === "empty transcript")
      jest
        .mocked(transcribeContentSnippet)
        .mockResolvedValueOnce({ status: "skipped" } as never);
    const f = await recoveryFixture("", {
      requested,
      context: withoutSavedPrompts,
      artifacts: pieces(1),
      transcript: (saved) => {
        saved.entries = [];
      },
    });
    const row = {
      ...f.claim.history,
      capture: completeCapture,
      ...(completionPolicy ? { completionPolicy: cancelledPolicy } : {}),
    };
    const input = await track(loadRecoveryFinishInput(row, signal(), f.reader));
    expect(input).toMatchObject({
      hasSavedAudio: true,
      transcript: text ? expect.stringContaining(text) : "",
    });
    expect(input).toMatchObject(expected);
    if (!completionPolicy) expect(input.cancel).toBeUndefined();
  },
);

test("the normal loader throws when transcription failed", async () => {
  jest
    .mocked(compileFinalTranscript)
    .mockImplementationOnce(async (meeting) => {
      meeting.processing = { transcription: "failed" };
    });
  jest
    .mocked(createMeetingTranscriptCompiler)
    .mockReturnValue(jest.fn(async () => "Final transcript."));
  await expect(
    loadNormalFinishInput(
      normalMeeting("Final transcript."),
      {} as Client,
      signal(),
    ),
  ).rejects.toThrow("Meeting processing failed or remains incomplete");
  expect(compileTranscriptForUpload).not.toHaveBeenCalled();
});

test("a mix render failure returns the input without a recording and removes its directory", async () => {
  const f = await singleUntranscribedPiece();
  let directory: string | undefined;
  jest
    .mocked(renderMixedPcmTracks)
    .mockImplementationOnce(async (_tracks, output) => {
      directory = output.slice(0, output.lastIndexOf("mixed.mp3") - 1);
      throw new Error("Synthetic encoder failure");
    });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const input = await track(
    loadRecoveryFinishInput(f.claim.history, signal(), f.reader),
  );
  expect(input.hasSavedAudio).toBe(true);
  expect(input.recordingPath).toBeUndefined();
  expect(input.localDirectory).toBeUndefined();
  expect(input.transcript).toContain("Recovered discussion.");
  expect(directory).toBeDefined();
  await expect(fs.stat(directory!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(error).toHaveBeenCalledWith(
    "Recovered recording render failed",
    expect.objectContaining({ meetingId: f.claim.history.meetingId }),
  );
  error.mockRestore();
});

describe("recovery evaluates auto-record cancellation", () => {
  const ELAPSED_MS = 30_000;
  const undecidedPolicy: CompletionPolicy = {
    ...cancelledPolicy,
    elapsedMilliseconds: ELAPSED_MS,
    decision: "undecided",
  };
  const decide = jest.mocked(decideAutoRecordCancellation);

  async function recover(overrides: Partial<MeetingHistory> = {}) {
    const f = await singleUntranscribedPiece();
    return track(
      loadRecoveryFinishInput(
        {
          ...f.claim.history,
          isAutoRecording: true,
          capture: completeCapture,
          completionPolicy: undecidedPolicy,
          ...overrides,
        },
        signal(),
        f.reader,
      ),
    );
  }

  test("an undecided auto-recording that ended complete is evaluated on recovery and cancelled when the evaluation says cancel", async () => {
    decide.mockResolvedValueOnce({ cancel: true, reason: "Synthetic reason" });
    const input = await recover();
    expect(decide).toHaveBeenCalledTimes(1);
    const facts = decide.mock.calls[0][0];
    expect(facts).toMatchObject({
      policy: undecidedPolicy.policy,
      durationSeconds: ELAPSED_MS / 1000,
      chatMessageCount: 0,
      meetingId: history.meetingId,
      guildId: history.guildId,
      channelId: history.channelId,
    });
    await expect(facts.content()).resolves.toEqual({
      transcriptText: "Recovered discussion.",
      chatLines: [],
    });
    expect(input.transcript).toContain("Recovered discussion.");
    expect(input.cancel).toEqual({ reason: "Synthetic reason" });
    expect(input.notesInput.notesPrompt).toBeUndefined();
  });

  test("an undecided auto-recording proceeds when the evaluation says keep", async () => {
    const input = await recover();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(input.cancel).toBeUndefined();
    expect(input.notesInput.notesPrompt).toBeDefined();
  });

  test("an interrupted auto-recording is never evaluated and proceeds", async () => {
    const input = await recover({ capture: interruptedCaptureState });
    expect(decide).not.toHaveBeenCalled();
    expect(input.cancel).toBeUndefined();
  });

  test("a manual recording is never evaluated", async () => {
    const input = await recover({
      isAutoRecording: false,
      completionPolicy: { ...undecidedPolicy, isAutoRecording: false },
    });
    expect(decide).not.toHaveBeenCalled();
    expect(input.cancel).toBeUndefined();
  });

  test.each([
    ["cancel", {}],
    ["proceed", undefined],
  ] as const)(
    "a stored %s decision is honoured without evaluating",
    async (decision, cancel) => {
      const input = await recover({
        completionPolicy: { ...undecidedPolicy, decision },
      });
      expect(decide).not.toHaveBeenCalled();
      expect(input.cancel).toEqual(cancel);
    },
  );

  test("an evaluation that throws proceeds to notes and logs", async () => {
    const failure = new Error("Synthetic provider failure");
    decide.mockRejectedValueOnce(failure);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const input = await recover();
      expect(input.cancel).toBeUndefined();
      expect(input.notesInput.notesPrompt).toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        "Recovered auto-record cancellation check failed; proceeding",
        expect.objectContaining({
          meetingId: history.meetingId,
          error: failure,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("an undecided auto-recording without its original duration proceeds unevaluated and logs", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const input = await recover({
        completionPolicy: {
          ...undecidedPolicy,
          elapsedMilliseconds: undefined,
        },
      });
      expect(decide).not.toHaveBeenCalled();
      expect(input.cancel).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Recovered auto-record cancellation check failed; proceeding",
        expect.objectContaining({ meetingId: history.meetingId }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  async function recoverWithChat(
    chatContext: string,
    chatMessageCount: number,
    attemptSignal = signal(),
  ) {
    const f = await recoveryFixture("", {
      context: (saved) => {
        savedTranscriptionPrompt(saved);
        saved.chatContext = chatContext;
      },
      artifacts: pieces(1),
      transcript: (saved) => {
        saved.entries = [];
      },
    });
    return loadRecoveryFinishInput(
      {
        ...f.claim.history,
        isAutoRecording: true,
        capture: completeCapture,
        completionPolicy: { ...undecidedPolicy, chatMessageCount },
      },
      attemptSignal,
      f.reader,
    );
  }

  const actualDecide = jest.requireActual<
    typeof import("../../src/services/autoRecordCancellationService")
  >(
    "../../src/services/autoRecordCancellationService",
  ).decideAutoRecordCancellation;
  const promptSent = (model: jest.SpiedFunction<typeof generateOpenAIText>) =>
    JSON.stringify(model.mock.calls[0][0].input);

  test("a saved chat context with only join and leave lines sends no names or formatted lines to the model", async () => {
    decide.mockImplementationOnce(actualDecide);
    const model = jest
      .spyOn(openaiText, "generateOpenAIText")
      .mockResolvedValueOnce('{"cancel":false}');
    try {
      await track(
        recoverWithChat(
          "[Synthetic Person (synthetic_user)] joined the channel at 1/1/2025\n[Synthetic Person (synthetic_user)] left the channel at 1/1/2025",
          0,
        ),
      );
      const prompt = promptSent(model);
      expect(prompt).not.toContain("Synthetic Person");
      expect(prompt).not.toContain("synthetic_user");
      expect(prompt).toContain("Chat sample: No chat messages.");
      expect(prompt).toContain("Chat messages: 0");
    } finally {
      model.mockRestore();
    }
  });

  test("a recovered auto-recording with chat messages proceeds unevaluated and logs, since the messages are not kept", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const input = await track(
        recoverWithChat(
          "[Synthetic Person (synthetic_user) @ 1/1/2025]: hello there",
          1,
        ),
      );
      expect(decide).not.toHaveBeenCalled();
      expect(input.cancel).toBeUndefined();
      expect(input.notesInput.notesPrompt).toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        "Recovered auto-record cancellation check failed; proceeding",
        expect.objectContaining({ meetingId: history.meetingId }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("the recovered evaluation counts words and samples text from the segments, without speaker names or timestamps", async () => {
    decide.mockImplementationOnce(actualDecide);
    const model = jest
      .spyOn(openaiText, "generateOpenAIText")
      .mockResolvedValueOnce('{"cancel":false}');
    try {
      const f = await savedMiddlePiece();
      const input = await track(
        loadRecoveryFinishInput(
          {
            ...f.claim.history,
            isAutoRecording: true,
            capture: completeCapture,
            completionPolicy: undecidedPolicy,
          },
          signal(),
          f.reader,
        ),
      );
      // The formatted transcript keeps its speaker prefix for everything else.
      expect(input.transcript).toContain("Speaker @");
      await expect(decide.mock.calls[0][0].content()).resolves.toEqual({
        transcriptText: `${SAVED_TEXT} Recovered discussion. Recovered discussion.`,
        chatLines: [],
      });
      const prompt = promptSent(model);
      expect(prompt).toContain("Transcript word count: 12");
      expect(prompt).toContain(
        `Transcript sample: ${SAVED_TEXT} Recovered discussion. Recovered discussion.`,
      );
      expect(prompt).not.toContain("Speaker");
      expect(prompt).not.toContain(" @ ");
    } finally {
      model.mockRestore();
    }
  });

  test("a stored transcript with no segments proceeds unevaluated and logs", async () => {
    const f = await savedMiddlePiece();
    const key = `${f.claim.history.checkpoint!.artifactFolder}transcript.json`;
    jest.mocked(fetchJsonFromS3).mockResolvedValueOnce({
      text: "[Speaker @ time]: Stored transcript.",
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const input = await track(
        loadRecoveryFinishInput(
          {
            ...f.claim.history,
            transcriptS3Key: key,
            isAutoRecording: true,
            capture: completeCapture,
            completionPolicy: undecidedPolicy,
          },
          signal(),
          f.reader,
        ),
      );
      expect(decide).not.toHaveBeenCalled();
      expect(input.cancel).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Recovered auto-record cancellation check failed; proceeding",
        expect.objectContaining({ meetingId: history.meetingId }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("an aborted attempt aborts the evaluation's call and the loader rethrows it", async () => {
    decide.mockImplementationOnce(actualDecide);
    const controller = new AbortController();
    const abort = new Error("Synthetic shutdown");
    const model = jest
      .spyOn(openaiText, "generateOpenAIText")
      .mockImplementationOnce(async (request) => {
        controller.abort(abort);
        request.signal?.throwIfAborted();
        return '{"cancel":false}';
      });
    try {
      await expect(recoverWithChat("", 0, controller.signal)).rejects.toBe(
        abort,
      );
      expect(model.mock.calls[0][0].signal?.aborted).toBe(true);
    } finally {
      model.mockRestore();
    }
  });
});
