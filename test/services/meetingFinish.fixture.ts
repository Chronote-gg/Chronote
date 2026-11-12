import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMockMeetingFinishRepository } from "../../src/repositories/meetingFinishRepository";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import {
  createMeetingFinisher,
  type MeetingFinishDeps,
} from "../../src/services/meetingFinish";
import type { FinishInput } from "../../src/services/meetingFinishInput";
import { resolveMeetingNameFromSummary } from "../../src/services/meetingNameService";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "../../src/services/meetingNotesService";
import { generateMeetingSummaries } from "../../src/services/meetingSummaryService";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { getNotes } from "../../src/services/notesService";
import type { MeetingHistory } from "../../src/types/db";
import type { MeetingNotesInput } from "../../src/types/meeting-data";
import type { RecordingCheckpoint } from "../../src/types/recordingCheckpoint";
import {
  acceptingUpload,
  stubFollowOns,
} from "../fixtures/meetingFinishPipeline";
import {
  GUILD_ID,
  MEETING_SECONDS,
  START,
  START_MESSAGE_ID,
  TEXT_CHANNEL_ID,
  VOICE_CHANNEL_ID,
  fakeDiscord,
  history,
  snowflake,
} from "./meetingDelivery.fixture";

export const OWNER = "synthetic-finisher";
export const CREATOR_ID = "500";
export const START_SECONDS = Date.parse(START) / 1000 + MEETING_SECONDS + 60;
export const TRANSCRIPT = "Synthetic speaker: we agreed on a placeholder plan.";
export const TRANSCRIPT_KEY = "synthetic/folder/transcript.json";
export const FORBIDDEN = 403;
export const SERVER_ERROR = 500;
export const GENERATED_NOTE = "- Synthetic generated note.";
export const GENERATED_SUMMARY = "Synthetic generated summary.";
export const NOTICE_MESSAGE_ID = snowflake(Date.parse(START) + 5_000);

export const CHECKPOINT: RecordingCheckpoint = {
  artifactFolder: "synthetic/folder/",
  schemaVersion: 1,
  revision: 1,
  capture: {
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    channelId_timestamp: `${VOICE_CHANNEL_ID}#${START}`,
    meetingId: "meeting-synthetic",
    ownerInstanceId: "instance-synthetic",
    executionVersion: 1,
    reservedAt: START,
    captureStartedAt: START,
    requested: { transcribeMeeting: true, generateNotes: true },
  },
  manifest: {
    key: "synthetic/folder/manifest.json",
    checksumSha256: "0".repeat(64),
    byteLength: 1,
  },
};

export const processingRow = (overrides: Partial<MeetingHistory> = {}) =>
  history({
    status: "processing",
    notes: undefined,
    summarySentence: undefined,
    processing: undefined,
    meetingCreatorId: CREATOR_ID,
    capture: {
      kind: "complete",
      startedAt: START,
      endedAt: new Date(
        Date.parse(START) + MEETING_SECONDS * 1000,
      ).toISOString(),
    },
    ...overrides,
  });

/** A processing row of an auto-recording the channel rule started. */
export const autoRecordingRow = (overrides: Partial<MeetingHistory> = {}) =>
  processingRow({
    isAutoRecording: true,
    startTriggeredByUserId: CREATOR_ID,
    autoRecordRule: { mode: "channel", channelId: VOICE_CHANNEL_ID },
    ...overrides,
  });

export function notesInput(
  overrides: Partial<MeetingNotesInput> = {},
): MeetingNotesInput {
  return {
    meetingId: "meeting-synthetic",
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    generateNotes: true,
    transcribeMeeting: true,
    startTime: new Date(START),
    finalTranscript: TRANSCRIPT,
    processing: { transcription: "ready" },
    tags: ["alpha"],
    participants: new Map(),
    attendance: new Set(),
    creator: { id: CREATOR_ID },
    guild: { id: GUILD_ID, name: "", description: "" },
    voiceChannel: { id: VOICE_CHANNEL_ID, name: "" },
    ...overrides,
  };
}

export function finishInput(overrides: Partial<FinishInput> = {}): FinishInput {
  return {
    source: "recovery",
    notesInput: notesInput(),
    transcript: TRANSCRIPT,
    transcriptUpload: { key: TRANSCRIPT_KEY, body: Buffer.from("{}") },
    processing: { transcription: "ready" },
    participants: [{ id: CREATOR_ID, username: "synthetic-user" }],
    hasSavedAudio: true,
    ...overrides,
  };
}

export const chatEntry = () => ({
  type: "message" as const,
  user: { id: CREATOR_ID, username: "synthetic-user" },
  channelId: TEXT_CHANNEL_ID,
  content: "Synthetic chat line.",
  timestamp: START,
});

export function setup(initial: MeetingHistory) {
  const histories = new Map([[GUILD_ID, [structuredClone(initial)]]]);
  const repository = createMockMeetingFinishRepository(histories, new Map());
  const discord = fakeDiscord();
  let nowMs = START_SECONDS * 1000;
  let pending: (() => Promise<void>) | undefined;
  const deps: MeetingFinishDeps = {
    repository,
    transport: discord.transport,
    upload: acceptingUpload(),
    notes: jest.fn(ensureMeetingNotes),
    summaries: jest.fn(ensureMeetingSummaries),
    claimUpgrade: jest.fn(async () => undefined),
    followOns: stubFollowOns(),
    nowMs: () => nowMs,
    schedule(run) {
      pending = run;
      return () => {
        pending = undefined;
      };
    },
  };
  const finisher = createMeetingFinisher(deps);
  const updates = createMeetingUpdateService({
    repository: createMockMeetingUpdateDeliveryRepository(
      histories,
      () => true,
    ),
    ready: async () => undefined,
    syncNotes: jest.fn(async () => undefined),
  });
  const current = () => histories.get(GUILD_ID)![0];
  const nowSeconds = () => Math.floor(nowMs / 1000);
  async function claim() {
    // A retry is claimable once its time arrives; the test clock jumps there.
    const due = current().finish?.nextAttemptAt;
    if (due !== undefined && due > nowSeconds()) nowMs = due * 1000;
    // Only the operator command claims a row the old runtime left unmarked.
    const claimed = await repository.claim(
      structuredClone(current()),
      OWNER,
      nowSeconds(),
      { operator: current().lifecycleVersion === undefined },
    );
    if (!claimed) throw new Error("expected a claim");
    return claimed;
  }
  return {
    deps,
    discord,
    current,
    finish: async (
      load: (signal: AbortSignal) => Promise<FinishInput>,
      options?: Parameters<typeof finisher.finishMeeting>[2],
    ) => finisher.finishMeeting(await claim(), load, options),
    claim,
    finisher,
    /** A rename through the real update action, as a portal correction makes it. */
    correct: (meetingName: string) =>
      updates({
        key: {
          guildId: initial.guildId,
          channelId_timestamp: initial.channelId_timestamp,
        },
        mutation: { kind: "rename", meetingName },
        actor: { editedBy: CREATOR_ID },
      }),
    scheduled: () => pending !== undefined,
    tick: async () => {
      const run = pending;
      if (!run) throw new Error("no renewal scheduled");
      pending = undefined;
      await run();
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    posts: () => discord.requests.filter((r) => r.method === "POST"),
    edits: () => discord.requests.filter((r) => r.method === "PATCH"),
  };
}

export type FinishWorld = ReturnType<typeof setup>;

export const loads = (input: FinishInput) => jest.fn(async () => input);
export const startMessage = (world: FinishWorld) =>
  world.discord.messages.find((message) => message.id === START_MESSAGE_ID)!;
export const errorsLogged = (line: string) =>
  jest.mocked(console.error).mock.calls.filter(([first]) => first === line)
    .length;

export async function recordingDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));
  const recordingPath = path.join(directory, "mixed.mp3");
  await fs.writeFile(recordingPath, "mp3");
  return { directory, recordingPath };
}
export const exists = (directory: string) =>
  fs.stat(directory).then(
    () => true,
    () => false,
  );

/**
 * Every test file using this world mocks the generation modules without a
 * factory; this gives those mocks the answers the pipeline expects, and keeps
 * the console quiet.
 */
export function useMeetingFinishHooks() {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getNotes).mockImplementation(async () => GENERATED_NOTE);
    jest.mocked(generateMeetingSummaries).mockImplementation(async () => ({
      summarySentence: GENERATED_SUMMARY,
      summaryLabel: "Synthetic label",
    }));
    jest
      .mocked(resolveMeetingNameFromSummary)
      .mockImplementation(async () => "Synthetic meeting");
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
}
