/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/storageService", () => ({
  ...jest.requireActual("../../src/services/storageService"),
  fetchJsonFromS3: jest.fn(),
}));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeContentSnippet: jest.fn(),
}));
jest.mock("../../src/services/processingRetryNotesInput", () => ({
  buildCurrentNotesInput: jest.fn(),
}));
import { transcribeContentSnippet } from "../../src/services/transcriptionService";
import { fetchJsonFromS3 } from "../../src/services/storageService";
import { buildCurrentNotesInput } from "../../src/services/processingRetryNotesInput";
import { loadRecoveryFinishInput } from "../../src/services/meetingFinishInput";
import {
  INTERRUPTED_CAPTURE_NOTICE,
  InvalidRecoveryContent,
} from "../../src/services/meetingRecoveryContent";
import type { MeetingHistory } from "../../src/types/db";
import { history } from "../fixtures/meetingHistory";
import { pcmArtifact, recoveryFixture } from "./meetingRecoveryFixtures";
import {
  CURRENT_SERVER_NAME,
  TRANSCRIPT_KEY,
  currentSettingsNotesInput,
} from "./meetingFinish.fixture";

const STORED_TEXT = "Synthetic speaker agreed on a placeholder plan.";
const LOST_AUDIO = Buffer.alloc(3840, 7);
const completeEnd = {
  kind: "complete" as const,
  startedAt: history.timestamp,
  endedAt: history.timestamp,
};
const unusedReader = () => ({ read: jest.fn(), readVerifiedObject: jest.fn() });
const signal = () => new AbortController().signal;

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(buildCurrentNotesInput)
    .mockImplementation(currentSettingsNotesInput);
});

const storedTranscript = () =>
  jest.mocked(fetchJsonFromS3).mockResolvedValueOnce({ text: STORED_TEXT });

/** A complete manifest that lists one audio piece whose object is gone. */
async function lostAudioCheckpoint() {
  const f = await recoveryFixture(STORED_TEXT, {
    captureState: completeEnd,
    artifacts: [
      pcmArtifact("user:123", 0, LOST_AUDIO, [
        { startOffsetMs: 0, durationMs: 20 },
      ]),
    ],
  });
  for (const [key, bytes] of f.objects)
    if (bytes.equals(LOST_AUDIO)) f.objects.delete(key);
  return f;
}

/** Built from the stored transcript, with no audio to mix or transcribe. */
function expectFromStoredTranscript(
  input: Awaited<ReturnType<typeof loadRecoveryFinishInput>>,
) {
  expect(fetchJsonFromS3).toHaveBeenCalledWith(
    TRANSCRIPT_KEY,
    expect.anything(),
  );
  expect(input).toMatchObject({
    source: "recovery",
    hasSavedAudio: true,
    transcript: STORED_TEXT,
    notesInput: { finalTranscript: STORED_TEXT },
  });
  expect(input.transcriptUpload).toBeUndefined();
  expect(input.recordingPath).toBeUndefined();
  expect(input.localDirectory).toBeUndefined();
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
}

describe("a saved transcript is used when no audio verifies", () => {
  test("with no checkpoint, from the row and the server's current settings, as interrupted", async () => {
    storedTranscript();
    const reader = unusedReader();
    const input = await loadRecoveryFinishInput(
      { ...history, capture: completeEnd, transcriptS3Key: TRANSCRIPT_KEY },
      signal(),
      reader,
    );
    expectFromStoredTranscript(input);
    expect(reader.read).not.toHaveBeenCalled();
    expect(buildCurrentNotesInput).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: history.meetingId }),
      STORED_TEXT,
      expect.anything(),
    );
    expect(input).toMatchObject({
      processing: { transcription: "partial" },
      notesInput: {
        captureNotice: INTERRUPTED_CAPTURE_NOTICE,
        processing: { transcription: "partial" },
        guild: { name: CURRENT_SERVER_NAME },
      },
      participants: history.participants,
      capture: {
        kind: "interrupted",
        startedAt: completeEnd.startedAt,
        endedAt: completeEnd.endedAt,
      },
    });
  });

  test("with a checkpoint holding no verified audio, from its frozen inputs", async () => {
    const f = await recoveryFixture(STORED_TEXT);
    storedTranscript();
    const input = await loadRecoveryFinishInput(
      {
        ...f.claim.history,
        capture: completeEnd,
        transcriptS3Key: TRANSCRIPT_KEY,
      },
      signal(),
      f.reader,
    );
    expectFromStoredTranscript(input);
    expect(buildCurrentNotesInput).not.toHaveBeenCalled();
    expect(input.notesInput.notesPrompt).toBeDefined();
    expect(input.notesInput.frozenModels).toBeDefined();
    expect(input).toMatchObject({
      processing: { transcription: "partial" },
      notesInput: {
        guild: { name: "Saved server" },
        captureNotice: expect.stringContaining(INTERRUPTED_CAPTURE_NOTICE),
      },
      capture: { kind: "interrupted" },
    });
  });

  test.each([
    { name: "no checkpoint", checkpoint: false },
    { name: "a checkpoint with no verified audio", checkpoint: true },
  ])(
    "an unreadable saved transcript with $name throws, never reporting no saved audio",
    async ({ checkpoint }) => {
      jest.mocked(fetchJsonFromS3).mockResolvedValueOnce(undefined);
      const saved = checkpoint
        ? await recoveryFixture(STORED_TEXT)
        : { claim: { history: { ...history } }, reader: unusedReader() };
      const row: MeetingHistory = {
        ...saved.claim.history,
        transcriptS3Key: TRANSCRIPT_KEY,
      };
      await expect(
        loadRecoveryFinishInput(row, signal(), saved.reader),
      ).rejects.toBeInstanceOf(InvalidRecoveryContent);
    },
  );
});

describe("a manifest recording a complete capture that lists audio none of which verifies", () => {
  test("is invalid recovery content, not a silent recording", async () => {
    const f = await lostAudioCheckpoint();
    await expect(
      loadRecoveryFinishInput(
        { ...f.claim.history, capture: completeEnd },
        signal(),
        f.reader,
      ),
    ).rejects.toBeInstanceOf(InvalidRecoveryContent);
    expect(fetchJsonFromS3).not.toHaveBeenCalled();
  });

  test("is built from a saved transcript when there is one", async () => {
    const f = await lostAudioCheckpoint();
    storedTranscript();
    const input = await loadRecoveryFinishInput(
      {
        ...f.claim.history,
        capture: completeEnd,
        transcriptS3Key: TRANSCRIPT_KEY,
      },
      signal(),
      f.reader,
    );
    expectFromStoredTranscript(input);
    expect(input.processing).not.toEqual({ transcription: "empty" });
  });
});
