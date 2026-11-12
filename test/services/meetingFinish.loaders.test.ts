/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService");
jest.mock("../../src/services/notesService");
jest.mock("../../src/services/meetingSummaryService");
jest.mock("../../src/services/meetingNameService");
// The normal loader runs for real; the capture steps it calls are stubbed.
jest.mock("../../src/services/meetingCaptureWrapUp", () => ({
  settleCapturedAudio: jest.fn(async () => undefined),
  resolveMeetingCancellation: jest.fn(async () => ({ kind: "proceed" })),
  buildMeetingRecording: jest.fn(async () => "synthetic/missing-mix.mp3"),
  compileFinalTranscript: jest.fn(
    async (meeting: { finalTranscript?: string; processing?: object }) => {
      meeting.finalTranscript = "";
      meeting.processing = { transcription: "empty" };
    },
  ),
  compileTranscriptForUpload: jest.fn(async () => ""),
  compileCancelledTranscript: jest.fn(async () => undefined),
  captionMeetingImagesStep: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/transcriptCompilationService", () => ({
  createMeetingTranscriptCompiler: jest.fn(() => jest.fn(async () => "")),
}));
// The recovery loader runs for real; its cancellation check and mix are stubbed.
jest.mock("../../src/services/autoRecordCancellationService", () => ({
  ...jest.requireActual("../../src/services/autoRecordCancellationService"),
  decideAutoRecordCancellation: jest.fn(async () => ({ cancel: false })),
}));
jest.mock("../../src/services/mixedPcmService", () => ({
  renderMixedPcmTracks: jest.fn(async () => undefined),
}));

import type { Client } from "discord.js";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { resolveMeetingCancellation } from "../../src/services/meetingCaptureWrapUp";
import { sumMeetingSecondsInWindow } from "../../src/services/meetingUsageService";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  loadNormalFinishInput,
  loadRecoveryFinishInput,
} from "../../src/services/meetingFinishInput";
import { decideAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import { getNotes } from "../../src/services/notesService";
import { MEETING_FINISH_FAILED_LOG } from "../../src/metrics";
import type { MeetingHistory } from "../../src/types/db";
import { EMPTY_RECORDING_NOTICE } from "../../src/utils/meetingProcessing";
import { autoRecordCompletionPolicy } from "../fixtures/completionPolicy";
import {
  pcmArtifact,
  recoveryFixture,
  withoutFinalPass,
} from "./meetingRecoveryFixtures";
import { INTERRUPTED_CAPTURE_NOTICE } from "../../src/services/meetingRecoveryContent";
import type { RecordingCaptureState } from "../../src/types/recordingCheckpoint";
import {
  DONE_MARKER,
  GUILD_ID,
  MEETING_SECONDS,
  START,
  VOICE_CHANNEL_ID,
  discordMessage,
} from "./meetingDelivery.fixture";
import {
  CREATOR_ID,
  NOTICE_MESSAGE_ID,
  autoRecordingRow,
  errorsLogged,
  processingRow,
  setup,
  startMessage,
  useMeetingFinishHooks,
  type FinishWorld,
} from "./meetingFinish.fixture";

useMeetingFinishHooks();

/** A live meeting in which nobody spoke, for the real normal loader. */
function silentMeeting(overrides: Partial<MeetingData> = {}): MeetingData {
  const value = {
    meetingId: "meeting-synthetic",
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    transcribeMeeting: true,
    generateNotes: true,
    isAutoRecording: false,
    startTime: new Date(START),
    tags: [],
    participants: new Map(),
    attendance: new Set(),
    creator: { id: CREATOR_ID },
    guild: { id: GUILD_ID, name: "Synthetic server", description: "" },
    voiceChannel: { id: VOICE_CHANNEL_ID, name: "Synthetic voice" },
    audioData: { audioFiles: [] },
    chatLog: [],
    ...overrides,
  };
  return value as unknown as MeetingData;
}
const normalLoad = (meeting: MeetingData) => (signal: AbortSignal) =>
  loadNormalFinishInput(meeting, {} as Client, signal);

/** Finishes a silent auto-recording whose start notice is still posted. */
async function finishSilentAutoRecording(world: FinishWorld) {
  world.discord.messages.push(
    discordMessage(NOTICE_MESSAGE_ID, { content: "Auto-recording started" }),
  );
  await world.finish(
    normalLoad(
      silentMeeting({
        isAutoRecording: true,
        messagesToDelete: [NOTICE_MESSAGE_ID],
      }),
    ),
  );
}
const noticeRemains = (world: FinishWorld) =>
  world.discord.messages.some((message) => message.id === NOTICE_MESSAGE_ID);

/** A meeting with no speech completes unmetered, with the no-speech notice and no notes. */
function expectCompletedWithNoSpeechNotice(
  world: FinishWorld,
  row: MeetingHistory,
) {
  expect(row).toMatchObject({
    status: "complete",
    processing: {
      transcription: "empty",
      notes: "skipped",
      summary: "skipped",
    },
    recovery: DONE_MARKER,
  });
  expect(row.notes).toBeUndefined();
  expect(startMessage(world).embeds[0]).toMatchObject({
    description: "Summary unavailable.",
  });
  expect(JSON.stringify(world.discord.messages)).toContain(
    EMPTY_RECORDING_NOTICE,
  );
  expect(
    sumMeetingSecondsInWindow([row], 0, Date.parse(START) + 86_400_000),
  ).toBe(0);
}

test("auto-record cancel with no speech ends cancelled with the cancelled embed", async () => {
  jest.mocked(resolveMeetingCancellation).mockResolvedValueOnce({
    kind: "automatic",
    decision: { cancel: true, reason: "Synthetic: not enough speech." },
  });
  const world = setup(autoRecordingRow({ endReason: "channel_empty" }));
  await finishSilentAutoRecording(world);
  expect(world.current()).toMatchObject({
    status: "cancelled",
    endReason: "auto_cancelled",
    cancellationReason: "Synthetic: not enough speech.",
    recovery: DONE_MARKER,
  });
  expect(startMessage(world).embeds[0]).toMatchObject({
    title: "Auto-Recording Cancelled",
  });
  expect(noticeRemains(world)).toBe(false);
  expect(world.posts()).toHaveLength(0);
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
});

const PIECE_BYTES = 3840;
const SPOKEN = "Synthetic speaker agreed on a placeholder plan.";
/** One saved audio piece whose transcript is saved too, so recovery transcribes nothing. */
function transcribedPiece(
  text: string,
  options: Parameters<typeof recoveryFixture>[1] = {},
) {
  return recoveryFixture(text, {
    timestamp: START,
    context: withoutFinalPass,
    artifacts: [
      pcmArtifact("user:123", 0, Buffer.alloc(PIECE_BYTES, 1), [
        { startOffsetMs: 0, durationMs: 20 },
      ]),
    ],
    transcript: (transcript) => {
      transcript.entries[0].correspondence = {
        kind: "pcm",
        spans: [
          {
            sourceId: "user:123",
            sequence: 0,
            startByte: 0,
            endByte: PIECE_BYTES,
          },
        ],
      };
    },
    ...options,
  });
}

test("a recovered auto-recording cancelled by the evaluation ends cancelled with the cancelled message and no notes", async () => {
  const undecided = autoRecordCompletionPolicy({
    elapsedMilliseconds: 30_000,
    dismissed: false,
    decision: "undecided",
  });
  jest.mocked(decideAutoRecordCancellation).mockResolvedValueOnce({
    cancel: true,
    reason: "Synthetic: not enough speech.",
  });
  const row = autoRecordingRow({
    endReason: "channel_empty",
    completionPolicy: undecided,
  });
  // Only a capture whose final flush landed is evaluated as having ended complete.
  const saved = await transcribedPiece("Synthetic short chatter.", {
    captureState: row.capture,
  });
  const world = setup(row);
  await world.finish((signal) =>
    loadRecoveryFinishInput(
      {
        ...saved.claim.history,
        isAutoRecording: true,
        capture: row.capture,
        completionPolicy: undecided,
      },
      signal,
      saved.reader,
    ),
  );
  expect(decideAutoRecordCancellation).toHaveBeenCalledTimes(1);
  expect(world.current()).toMatchObject({
    status: "cancelled",
    endReason: "auto_cancelled",
    cancellationReason: "Synthetic: not enough speech.",
    completionPolicy: { decision: "cancel" },
    recovery: DONE_MARKER,
  });
  expect(world.current().notes).toBeUndefined();
  expect(startMessage(world).embeds[0]).toMatchObject({
    title: "Auto-Recording Cancelled",
  });
  expect(getNotes).not.toHaveBeenCalled();
  expect(world.posts()).toHaveLength(0);
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
});

test("a cancel decision close wrote is kept when the loader would proceed", async () => {
  const world = setup(
    autoRecordingRow({
      endReason: "dismissed",
      cancellationReason: "Stopped by synthetic user",
      completionPolicy: autoRecordCompletionPolicy({
        elapsedMilliseconds: 1_000,
        dismissed: true,
        decision: "cancel",
      }),
    }),
  );
  await finishSilentAutoRecording(world);
  expect(noticeRemains(world)).toBe(false);
  expect(world.current()).toMatchObject({
    status: "cancelled",
    endReason: "dismissed",
    cancellationReason: "Stopped by synthetic user",
    completionPolicy: { decision: "cancel" },
  });
  expect(world.posts()).toHaveLength(0);
});

test("a manual meeting with no speech ends complete with the no-speech notice and is not metered", async () => {
  const world = setup(processingRow());
  const state = { durationContent: "Synthetic duration notice." };
  await world.finish(
    normalLoad(silentMeeting({ recordingLimitNotice: state })),
  );
  const row = world.current();
  expectCompletedWithNoSpeechNotice(world, row);
  expect(world.deps.followOns.sendWeeklyLimitNotice).toHaveBeenCalledWith(
    expect.objectContaining({ meetingId: row.meetingId }),
    state,
    expect.anything(),
  );
});

describe("the processing state shown when the meeting stopped", () => {
  const PROCESSING_EDIT_DELAY_MS = 50;

  test("lands before delivery edits the recording message", async () => {
    const world = setup(processingRow());
    let requestsWhenShown: number | undefined;
    const processingMessageShown = new Promise<void>((resolve) =>
      setTimeout(resolve, PROCESSING_EDIT_DELAY_MS),
    ).then(() => {
      requestsWhenShown = world.discord.requests.length;
    });
    await world.finish(normalLoad(silentMeeting({ processingMessageShown })));
    expect(requestsWhenShown).toBe(0);
    expect(world.edits().length).toBeGreaterThan(0);
  });

  test("that never lands holds the finish only for its bound", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    try {
      const world = setup(processingRow());
      const processingMessageShown = new Promise<void>(() => undefined);
      const finished = world.finish(
        normalLoad(silentMeeting({ processingMessageShown })),
      );
      await jest.advanceTimersByTimeAsync(
        LIFECYCLE.processingMessageWaitMs - 1,
      );
      expect(world.discord.requests).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      await finished;
      expect(world.current().status).toBe("complete");
      expect(world.edits().length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

test("a recovered capture that ended complete with no saved audio ends complete with the no-speech notice and is not metered", async () => {
  const row = processingRow();
  // The completed final flush recorded the capture as complete in the manifest.
  const saved = await recoveryFixture("Synthetic unused text.", {
    timestamp: START,
    captureState: { kind: "complete", startedAt: START, endedAt: START },
  });
  const world = setup(row);
  await world.finish((signal) =>
    loadRecoveryFinishInput(
      { ...saved.claim.history, capture: row.capture },
      signal,
      saved.reader,
    ),
  );
  expectCompletedWithNoSpeechNotice(world, world.current());
  expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
});

/**
 * Close records a complete capture when its final flush failed but it kept the
 * audio for a local finish. Only the manifest proves the flush landed, so a
 * recovery without that proof finishes the meeting as interrupted.
 */
describe("a recovered capture the row records as complete", () => {
  const rowCapture = processingRow().capture;
  const captureEnd = new Date(
    Date.parse(START) + MEETING_SECONDS * 1000,
  ).toISOString();
  const interruptedRow = {
    kind: "interrupted" as const,
    startedAt: START,
    endedAt: null,
    detectedAt: START,
  };
  async function recover(
    manifestCapture: RecordingCaptureState | undefined,
    capture: MeetingHistory["capture"] = rowCapture,
  ) {
    const saved = await transcribedPiece(SPOKEN, {
      captureState: manifestCapture,
    });
    return (signal: AbortSignal) =>
      loadRecoveryFinishInput(
        { ...saved.claim.history, capture },
        signal,
        saved.reader,
      );
  }
  const load = async (load: Promise<(signal: AbortSignal) => unknown>) =>
    (await load)(new AbortController().signal);

  test("whose manifest records a complete capture loads unchanged", async () => {
    const input = await load(recover(rowCapture));
    expect(input).toMatchObject({ processing: { transcription: "ready" } });
    expect(input).not.toHaveProperty("capture");
    expect(input).toHaveProperty("notesInput.captureNotice", undefined);
  });

  test("whose manifest does not loads as interrupted, keeping the row's start and end", async () => {
    const input = await load(recover(undefined));
    expect(input).toMatchObject({
      capture: {
        kind: "interrupted",
        startedAt: START,
        endedAt: captureEnd,
        detectedAt: expect.any(String),
      },
      processing: { transcription: "partial" },
      notesInput: {
        captureNotice: expect.stringContaining(INTERRUPTED_CAPTURE_NOTICE),
      },
    });
  });

  test("an interrupted row loads unchanged", async () => {
    const input = await load(recover(undefined, interruptedRow));
    expect(input).not.toHaveProperty("capture");
    expect(input).toHaveProperty(
      "notesInput.captureNotice",
      expect.stringContaining(INTERRUPTED_CAPTURE_NOTICE),
    );
  });

  test("whose manifest does not ends interrupted with the capture rewritten and the notice posted", async () => {
    const world = setup(processingRow());
    await world.finish(await recover(undefined));
    expect(world.current()).toMatchObject({
      status: "interrupted",
      capture: {
        kind: "interrupted",
        startedAt: START,
        endedAt: captureEnd,
      },
      recovery: DONE_MARKER,
    });
    expect(JSON.stringify(world.discord.messages)).toContain(
      "recording was interrupted",
    );
    expect(errorsLogged(MEETING_FINISH_FAILED_LOG)).toBe(0);
  });
});
