import { PassThrough } from "node:stream";
import { VoiceConnectionStatus } from "@discordjs/voice";
import {
  subscribeToUserVoice,
  userStartTalking,
  userStopTalking,
} from "../../src/audio";
import type { MeetingData } from "../../src/types/meeting-data";

const mockDecoders: PassThrough[] = [];

jest.mock("prism-media", () => {
  const { PassThrough: MockPassThrough } =
    jest.requireActual<typeof import("node:stream")>("node:stream");
  return {
    opus: {
      Decoder: class FakeDecoder extends MockPassThrough {
        constructor() {
          super();
          mockDecoders.push(this);
        }
      },
    },
  };
});

function createMeeting(streams: PassThrough[]) {
  const receiver = {
    subscriptions: new Map<string, PassThrough>(),
    subscribe: jest.fn((userId: string) => {
      const stream = new PassThrough();
      streams.push(stream);
      receiver.subscriptions.set(userId, stream);
      return stream;
    }),
  };
  const meeting = {
    meetingId: "meeting-1",
    chatLog: [],
    attendance: new Set<string>(),
    connection: {
      receiver,
      state: { status: VoiceConnectionStatus.Ready },
    },
    textChannel: {} as MeetingData["textChannel"],
    voiceChannel: {
      members: new Map([["user-1", {}]]),
    } as MeetingData["voiceChannel"],
    guildId: "guild-1",
    channelId: "channel-1",
    audioData: { currentSnippets: new Map(), audioFiles: [] },
    startTime: new Date(),
    creator: {} as MeetingData["creator"],
    guild: {} as MeetingData["guild"],
    finishing: false,
    isFinished: Promise.resolve(),
    setFinished: () => {},
    finished: false,
    transcribeMeeting: true,
    generateNotes: true,
    participants: new Map(),
    isAutoRecording: false,
  } as MeetingData;
  return { meeting, receiver };
}

describe("voice subscriptions", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDecoders.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("resubscribes after opus stream error", async () => {
    const streams: PassThrough[] = [];
    const { meeting, receiver } = createMeeting(streams);

    await subscribeToUserVoice(meeting, "user-1");

    expect(receiver.subscribe).toHaveBeenCalledTimes(1);
    streams[0].emit("error", new Error("corrupt"));
    expect(meeting.audioData.captureIncomplete).toBe(true);
    jest.runOnlyPendingTimers();
    expect(receiver.subscribe).toHaveBeenCalledTimes(2);

    meeting.audioData.captureIncomplete = false;
    userStartTalking(meeting, "user-1");
    jest.advanceTimersByTime(800);
    userStopTalking(meeting, "user-1");
    expect(meeting.audioData.captureIncomplete).toBe(true);

    meeting.audioData.captureIncomplete = false;
    meeting.finishing = true;
    streams[1].emit("error", new Error("finishing"));
    expect(meeting.audioData.captureIncomplete).toBe(false);

    meeting.finishing = false;
    meeting.connection.state.status = VoiceConnectionStatus.Destroyed;
    streams[1].emit("error", new Error("destroyed"));
    expect(meeting.audioData.captureIncomplete).toBe(false);

    meeting.finishing = true;
    meeting.connection.state.status = VoiceConnectionStatus.Ready;
    userStartTalking(meeting, "user-1");
    jest.advanceTimersByTime(800);
    userStopTalking(meeting, "user-1");
    expect(meeting.audioData.captureIncomplete).toBe(false);

    meeting.finishing = false;
    meeting.connection.state.status = VoiceConnectionStatus.Destroyed;
    userStartTalking(meeting, "user-1");
    jest.advanceTimersByTime(800);
    userStopTalking(meeting, "user-1");
    expect(meeting.audioData.captureIncomplete).toBe(false);
  });

  test.each([
    [
      "marked",
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 0xfa, 0xfa]),
      true,
    ],
    [
      "unmarked",
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 0, 0]),
      false,
    ],
    ["too short", Buffer.from([12, 0xfa, 0xfa]), false],
    [
      "impossible size",
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 0xfa, 0xfa]),
      false,
    ],
  ])("logs only shape for %s packet", async (_name, packet, candidate) => {
    const streams: PassThrough[] = [];
    const { meeting, receiver } = createMeeting(streams);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await subscribeToUserVoice(meeting, "user-1");
      streams[0].write(packet);
      mockDecoders[0].emit("error", new Error("decoder failed"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `opusPacketBytes=${packet.length} daveFooterCandidate=${candidate} daveTransitionAgoMs=none`,
        ),
      );
      expect(warn.mock.calls.join(" ")).not.toContain(packet.toString("hex"));
      expect(meeting.audioData.captureIncomplete).toBe(true);
      jest.runOnlyPendingTimers();
      expect(receiver.subscribe).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("logs missing packet and elapsed transition time without changing recovery", async () => {
    const streams: PassThrough[] = [];
    const { meeting, receiver } = createMeeting(streams);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await subscribeToUserVoice(meeting, "user-1");
      mockDecoders[0].emit("error", new Error("before packet"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "opusPacketBytes=none daveFooterCandidate=none daveTransitionAgoMs=none",
        ),
      );
      expect(meeting.audioData.captureIncomplete).toBe(true);
      jest.runOnlyPendingTimers();
      expect(receiver.subscribe).toHaveBeenCalledTimes(2);

      meeting.audioData.lastDaveTransitionAtMs = Date.now() - 123;
      mockDecoders[1].emit("error", new Error("after transition"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "opusPacketBytes=none daveFooterCandidate=none daveTransitionAgoMs=123",
        ),
      );
      expect(meeting.audioData.captureIncomplete).toBe(true);
      jest.runOnlyPendingTimers();
      expect(receiver.subscribe).toHaveBeenCalledTimes(3);

      meeting.audioData.lastDaveTransitionAtMs = Date.now() + 100;
      mockDecoders[2].emit("error", new Error("clock skew"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("daveTransitionAgoMs=0"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
