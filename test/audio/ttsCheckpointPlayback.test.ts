/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AudioPlayer } from "@discordjs/voice";
import type { MeetingData } from "../../src/types/meeting-data";
import { stopMeetingProcessing } from "../../src/services/meetingProcessingLifetime";
import { createTtsQueue } from "../../src/ttsQueue";
import { createCheckpointPlaybackTap } from "../../src/services/recordingCheckpointPlayback";
const mockSpeech = jest.fn();
const mockKill = jest.fn();
let mockHoldEncoder = false;
let mockResourceFailure = false;
const mockCommands: EventEmitter[] = [];
const mockOutput = () => {
  const stream = new PassThrough();
  setImmediate(() => stream.end(Buffer.alloc(3840)));
  return stream;
};
jest.mock("../../src/services/openaiClient", () => ({
  createOpenAIClient: () => ({
    audio: { speech: { create: (...args: unknown[]) => mockSpeech(...args) } },
  }),
}));
jest.mock("../../src/services/modelFactory", () => ({
  buildModelOverrides: jest.fn(),
  getModelChoice: () => ({ model: "generated" }),
}));
import { Collection } from "discord.js";
import {
  startRecordingContentCheckpoint,
  checkpointCompletedTranscription,
  guardRecordingFinalization,
  captureRecordingTranscriptScope,
} from "../../src/services/recordingContentService";
import { completedTranscriptionSchema } from "../../src/types/recordingContent";
import type { CheckpointArtifactInput } from "../../src/types/recordingCheckpoint";
jest.mock("../../src/services/recordingCheckpointPlayback", () => ({
  createCheckpointPlaybackTap: jest.fn(
    jest.requireActual("../../src/services/recordingCheckpointPlayback")
      .createCheckpointPlaybackTap,
  ),
}));
jest.mock("../../src/metrics", () => ({ chatTtsSpoken: { inc: jest.fn() } }));
jest.mock("fluent-ffmpeg", () => () => {
  const events = new (jest.requireActual("node:events").EventEmitter)();
  mockCommands.push(events);
  const chain = {
    inputOptions: () => chain,
    audioFrequency: () => chain,
    audioChannels: () => chain,
    format: () => chain,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      return chain;
    },
    audioFilters: () => chain,
    pipe: () => {
      if (!mockHoldEncoder) setImmediate(() => events.emit("end"));
      return mockOutput();
    },
    kill: (signal: string) => {
      mockKill(signal);
      if (!mockHoldEncoder) setImmediate(() => events.emit("end"));
    },
  };
  return chain;
});
jest.mock("prism-media", () => {
  const stream = jest.requireActual("node:stream");
  return { opus: { Encoder: stream.PassThrough } };
});
jest.mock("@discordjs/voice", () => ({
  AudioPlayerStatus: { Idle: "idle" },
  StreamType: { Opus: "opus" },
  createAudioResource: (playStream: PassThrough) => {
    if (mockResourceFailure) throw new Error("synthetic resource failure");
    const resource = {
      playStream,
      playbackDuration: 0,
      read: () => {
        resource.playbackDuration += 20;
        return Buffer.alloc(1);
      },
    };
    return resource;
  },
}));
function fixture(recordBotAudio = false) {
  const player = Object.assign(new EventEmitter(), {
    state: { status: "idle" },
    play: jest.fn((resource?: unknown): void => {
      void resource;
      setImmediate(() => player.emit("idle"));
    }),
    stop: jest.fn(),
  });
  const meeting = {
    recordBotAudio,
    guild: { id: "generated" },
    voiceChannel: { id: "generated" },
    meetingId: "generated",
    audioData: { audioFiles: [] },
    ownershipSignal: new AbortController().signal,
  } as unknown as MeetingData;
  return {
    meeting,
    player,
    queue: createTtsQueue(meeting, player as unknown as AudioPlayer),
  };
}
const body = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(1920));
      c.close();
    },
  });
const item = {
  text: "Generated speech",
  userId: "generated",
  voice: "alloy",
  source: "chat_tts" as const,
};
const settle = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
beforeEach(() => {
  jest.clearAllMocks();
  mockHoldEncoder = false;
  mockResourceFailure = false;
  mockCommands.length = 0;
  mockSpeech.mockResolvedValue({ body: body() });
});
test("TTS-only playback does not reserve recording PCM or stop itself", async () => {
  const f = fixture();
  f.queue.enqueue(item);
  await settle();
  expect(f.player.play).toHaveBeenCalledTimes(1);
  expect(createCheckpointPlaybackTap).not.toHaveBeenCalled();
  expect(f.player.stop).not.toHaveBeenCalled();
  expect(f.meeting.audioData.audioFiles[0].transcript).toBe(item.text);
});
test("stopped generation cannot play after a held speech response arrives", async () => {
  let complete!: (response: { body: ReadableStream<Uint8Array> }) => void;
  mockSpeech.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const f = fixture();
  f.queue.enqueue(item);
  f.queue.stopAndClear();
  complete({ body: body() });
  await settle();
  expect(f.player.play).not.toHaveBeenCalled();
  expect(createCheckpointPlaybackTap).not.toHaveBeenCalled();
});
test("pre-play failure disposes capture tap and ffmpeg without playing", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const f = fixture(true);
    f.queue.enqueue({
      ...item,
      onBeforePlay: () => {
        throw new Error("generated preplay failure");
      },
    });
    await settle();
    expect(f.player.play).not.toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    expect(
      jest.mocked(createCheckpointPlaybackTap).mock.results[0].value.stream
        .destroyed,
    ).toBe(true);
  } finally {
    error.mockRestore();
  }
});

test("processing stop retains an issued TTS provider until its late body is cancelled", async () => {
  let complete!: (response: { body: ReadableStream<Uint8Array> }) => void;
  let cancelBody!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancelBody = resolve;
  });
  mockSpeech.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const f = fixture();
  f.queue.enqueue(item);
  let settled = false;
  const drain = stopMeetingProcessing(f.meeting).then(() => {
    settled = true;
  });
  f.queue.stopAndClear();
  await settle();
  expect(settled).toBe(false);
  const lateBody = new ReadableStream<Uint8Array>({ cancel: () => cancelled });
  complete({ body: lateBody });
  await settle();
  expect(settled).toBe(false);
  expect(f.player.play).not.toHaveBeenCalled();
  cancelBody();
  await drain;
  expect(settled).toBe(true);
});

test("TTS playback settlement requires actual ffmpeg termination after kill request", async () => {
  mockHoldEncoder = true;
  const f = fixture();
  f.queue.enqueue(item);
  await settle();
  expect(mockKill).toHaveBeenCalledWith("SIGTERM");
  let settled = false;
  const drain = stopMeetingProcessing(f.meeting).then(() => {
    settled = true;
  });
  await settle();
  expect(settled).toBe(false);
  mockCommands[0].emit("end");
  await drain;
  expect(settled).toBe(true);
});

test("resource construction failure retains the started encoder until actual termination", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    mockResourceFailure = true;
    mockHoldEncoder = true;
    const f = fixture();
    f.queue.enqueue(item);
    await settle();
    let stopped = false;
    const drain = stopMeetingProcessing(f.meeting).then(() => {
      stopped = true;
    });
    await settle();
    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    expect(stopped).toBe(false);
    mockCommands[0].emit("end");
    await drain;
    expect(f.player.play).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Failed to stream TTS to Discord:",
      expect.objectContaining({ message: "synthetic resource failure" }),
    );
  } finally {
    error.mockRestore();
  }
});

function attachCheckpoint(f: ReturnType<typeof fixture>) {
  const artifacts: CheckpointArtifactInput[] = [];
  Object.assign(f.meeting, {
    guildId: "generated",
    channelId: "notes",
    transcribeMeeting: true,
    generateNotes: false,
    captureStartedAt: new Date(2000),
    creator: { id: "generated" },
    participants: new Map(),
    attendance: new Set(),
    chatLog: [],
    reservation: {
      sessionMode: "meeting",
      meetingId: "generated",
      guildId: "generated",
      ownerInstanceId: "owner",
      executionVersion: 1,
      voiceOperationAttemptId: "voice",
      reservedAt: 1000,
      historyKey: { guildId: "generated", channelId_timestamp: "voice#1000" },
    },
    recordingCapture: {
      queueContent: (artifact: CheckpointArtifactInput) => {
        artifacts.push(artifact);
        return true;
      },
    },
  });
  Object.assign(f.meeting.voiceChannel, { name: "Voice" });
  Object.assign(f.meeting.guild, {
    name: "Server",
    roles: new Collection(),
    scheduledEvents: new Collection(),
    channels: new Collection(),
    members: {},
    client: {},
  });
  startRecordingContentCheckpoint(f.meeting);
  return artifacts;
}
test.each([false, true])(
  "delayed actual TTS termination preserves late text across failed/finalized guard (%s)",
  async (acknowledged) => {
    mockHoldEncoder = true;
    const f = fixture(false);
    const artifacts = attachCheckpoint(f);
    const baseline = {
      userId: "generated",
      timestamp: 2000,
      transcript: "Before final pass",
      transcriptCorrespondence: { kind: "text_only" as const },
      processing: false,
      audioOnlyProcessing: false,
    };
    f.meeting.audioData.audioFiles.push(baseline);
    checkpointCompletedTranscription(f.meeting);
    f.queue.enqueue(item);
    await settle();
    expect(f.meeting.audioData.audioFiles).toHaveLength(1);
    guardRecordingFinalization(f.meeting);
    Object.assign(baseline, { finalPassTranscript: "Final pass result" });
    if (acknowledged) {
      captureRecordingTranscriptScope(f.meeting, [baseline]);
      checkpointCompletedTranscription(f.meeting, {
        finalPass: "acknowledged",
        cleanup: "disabled",
        finalText: "Final pass result",
      });
    }
    // stopAndClear requests termination but does not await the running finally block.
    f.queue.stopAndClear();
    await settle();
    expect(f.meeting.audioData.audioFiles).toHaveLength(1);
    mockCommands[0].emit("end");
    await settle();
    const raw = artifacts
      .filter((artifact) => artifact.kind === "transcription")
      .at(-1)!;
    const result = completedTranscriptionSchema.parse(
      JSON.parse(Buffer.from(raw.bytes).toString()),
    );
    expect(result.entries.map((entry) => entry.text)).toEqual([
      acknowledged ? "Final pass result" : "Before final pass",
      item.text,
    ]);
    expect(result.entries[1].correspondence).toEqual({ kind: "text_only" });
    if (acknowledged)
      expect(result.processing).toMatchObject({
        finalText: "Final pass result",
        supplementalEntries: true,
      });
    else expect(result.processing).toBeUndefined();
    await stopMeetingProcessing(f.meeting);
  },
);

test.each(["full", "partial"] as const)(
  "actual consumed TTS %s frames carry only acknowledged input receipts",
  async (mode) => {
    const f = fixture(true);
    let offset = 0;
    Object.assign(f.meeting, {
      recordingCapture: {
        push: (
          sourceId: string,
          chunk: Buffer,
          _at: number,
          accepted: (span: {
            sourceId: string;
            sequence: number;
            startByte: number;
            endByte: number;
          }) => void,
        ) => {
          accepted({
            sourceId,
            sequence: 0,
            startByte: offset,
            endByte: offset + chunk.length,
          });
          offset += chunk.length;
          return true;
        },
        interrupt: jest.fn(),
      },
    });
    f.player.play.mockImplementationOnce((resource?: unknown) => {
      const input = resource as {
        playStream: PassThrough;
        read(): Buffer | null;
      };
      input.playStream.resume();
      input.playStream.once("end", () => {
        if (mode === "full") input.read();
        f.player.emit("idle");
      });
    });
    f.queue.enqueue(item);
    await settle();
    await settle();
    const entry = f.meeting.audioData.audioFiles[0];
    if (mode === "full") {
      expect(entry.transcript).toBe(item.text);
      expect(entry.transcriptCorrespondence).toEqual({
        kind: "pcm",
        spans: [
          {
            sourceId: "bot:generated",
            sequence: 0,
            startByte: 0,
            endByte: 3840,
          },
        ],
      });
    } else {
      expect(entry.transcript).toBeUndefined();
      expect(entry.transcriptCorrespondence).toBeUndefined();
      expect(offset).toBe(0);
    }
    await stopMeetingProcessing(f.meeting);
  },
);
