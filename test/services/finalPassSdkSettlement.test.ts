/** @jest-environment node */
import { PassThrough } from "node:stream";
import type { MeetingData } from "../../src/types/meeting-data";
import { runTranscriptionFinalPass } from "../../src/services/transcriptionFinalPassService";
import { stopMeetingProcessing } from "../../src/services/meetingProcessingLifetime";
const mockCreate = jest.fn();
const mockFfmpeg = jest.fn();
jest.mock("fluent-ffmpeg", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFfmpeg(...args),
}));
const mockReadStream = jest.fn();
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  createReadStream: (...args: unknown[]) => mockReadStream(...args),
}));
jest.mock("../../src/services/openaiClient", () => ({
  createOpenAIClient: () => ({
    audio: { transcriptions: { create: mockCreate } },
  }),
}));
jest.mock("../../src/services/transcriptionPromptService", () => ({
  getTranscriptionPrompt: async () => ({ prompt: "synthetic" }),
}));
const buildSyntheticMeeting = (language?: string) =>
  ({
    meetingId: "synthetic",
    guildId: "synthetic",
    channelId: "voice",
    creator: { id: "synthetic" },
    guild: { id: "synthetic" },
    voiceChannel: { id: "synthetic" },
    participants: new Map(),
    startTime: new Date(0),
    endTime: new Date(120000),
    audioData: {
      audioFiles: [
        {
          userId: "synthetic",
          timestamp: 1000,
          transcript: "synthetic baseline",
          processing: false,
          audioOnlyProcessing: false,
        },
      ],
    },
    runtimeConfig: { transcription: { finalPassEnabled: true, language } },
  }) as unknown as MeetingData;
test("final-pass actual SDK cancellation retains its local upload stream until close", async () => {
  const meeting = buildSyntheticMeeting();
  let close!: () => void;
  const file = new PassThrough({
    destroy(_error, done) {
      close = () => done();
    },
  });
  mockReadStream.mockReturnValue(file);
  let entered!: () => void;
  const submitted = new Promise<void>((done) => {
    entered = done;
  });
  let release!: (value: { text: string }) => void;
  mockCreate.mockImplementation(() => {
    entered();
    return new Promise((done) => {
      release = done;
    });
  });
  const reconcile = jest.fn(async () => []);
  const cleanup = jest.fn(async () => {});
  const actual = runTranscriptionFinalPass(
    meeting,
    { audioFilePath: "synthetic.mp3" },
    {
      ensureTempDir: async () => "synthetic",
      getAudioDurationSeconds: async () => 120,
      renderAudioChunk: async () => {},
      reconcileBatch: reconcile,
      deleteTempFile: cleanup,
    },
  );
  const outcome = actual.then(
    () => "success",
    () => "cancelled",
  );
  await submitted;
  let drained = false;
  const drain = stopMeetingProcessing(meeting).then(() => {
    drained = true;
  });
  expect(mockCreate.mock.calls[0][1].signal.aborted).toBe(true);
  release({ text: "late result" });
  await new Promise<void>((done) => setImmediate(done));
  expect(drained).toBe(false);
  expect(cleanup).not.toHaveBeenCalled();
  close();
  expect(await outcome).toBe("cancelled");
  await drain;
  expect(reconcile).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test("final-pass chunk encoder cancellation waits its actual terminal event", async () => {
  const meeting = {
    meetingId: "synthetic-encoder",
    creator: { id: "synthetic-creator" },
    guild: { id: "synthetic-guild" },
    voiceChannel: { id: "synthetic-voice" },
    startTime: new Date(0),
    endTime: new Date(120000),
    participants: new Map(),
    audioData: {
      audioFiles: [
        {
          userId: "synthetic",
          timestamp: 1000,
          transcript: "baseline",
          processing: false,
        },
      ],
    },
    runtimeConfig: { transcription: { finalPassEnabled: true } },
  } as unknown as MeetingData;
  const handlers = new Map<string, () => void>();
  let entered!: () => void;
  const submitted = new Promise<void>((done) => {
    entered = done;
  });
  const command = {
    setStartTime: jest.fn(() => command),
    setDuration: jest.fn(() => command),
    audioCodec: jest.fn(() => command),
    audioBitrate: jest.fn(() => command),
    audioChannels: jest.fn(() => command),
    audioFrequency: jest.fn(() => command),
    toFormat: jest.fn(() => command),
    kill: jest.fn(),
    on: jest.fn((name: string, fn: () => void) => {
      handlers.set(name, fn);
      return command;
    }),
    save: jest.fn(() => {
      entered();
      return command;
    }),
  };
  mockFfmpeg.mockReturnValue(command);
  const transcribe = jest.fn(async () => ({ text: "unused" }));
  const cleanup = jest.fn(async () => {});
  const actual = runTranscriptionFinalPass(
    meeting,
    { audioFilePath: "synthetic.mp3" },
    {
      ensureTempDir: async () => "synthetic",
      getAudioDurationSeconds: async () => 120,
      transcribeChunk: transcribe,
      deleteTempFile: cleanup,
    },
  );
  const outcome = actual.then(
    () => "success",
    () => "cancelled",
  );
  await submitted;
  let drained = false;
  const drain = stopMeetingProcessing(meeting).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(command.kill).toHaveBeenCalledWith("SIGTERM");
  expect(cleanup).not.toHaveBeenCalled();
  handlers.get("end")!();
  expect(await outcome).toBe("cancelled");
  await drain;
  expect(transcribe).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
test.each([
  { language: undefined, expected: "en" },
  { language: "de", expected: "de" },
  { language: "auto", expected: undefined },
])(
  "final-pass request language for setting $language is $expected",
  async ({ language, expected }) => {
    mockReadStream.mockReturnValue(new PassThrough());
    mockCreate.mockReset().mockResolvedValue({ text: "synthetic baseline" });
    await runTranscriptionFinalPass(
      buildSyntheticMeeting(language),
      { audioFilePath: "synthetic.mp3" },
      {
        ensureTempDir: async () => "synthetic",
        getAudioDurationSeconds: async () => 120,
        renderAudioChunk: async () => {},
        reconcileBatch: async () => [],
        deleteTempFile: async () => {},
      },
    );
    const request = mockCreate.mock.calls[0][0];
    if (expected) expect(request).toHaveProperty("language", expected);
    else expect(request).not.toHaveProperty("language");
  },
);
