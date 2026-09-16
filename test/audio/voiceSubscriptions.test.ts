import { PassThrough } from "node:stream";
import { VoiceConnectionStatus } from "@discordjs/voice";
import {
  subscribeToUserVoice,
  userStartTalking,
  userStopTalking,
} from "../../src/audio";
import type { MeetingData } from "../../src/types/meeting-data";

jest.mock("prism-media", () => {
  const { PassThrough: MockPassThrough } =
    jest.requireActual<typeof import("node:stream")>("node:stream");
  return {
    opus: {
      Decoder: class FakeDecoder extends MockPassThrough {
        constructor() {
          super();
        }
      },
    },
  };
});

describe("voice subscriptions", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("resubscribes after opus stream error", async () => {
    const streams: PassThrough[] = [];
    const receiver = {
      subscriptions: new Map<string, PassThrough>(),
      subscribe: jest.fn((userId: string) => {
        const stream = new PassThrough();
        streams.push(stream);
        receiver.subscriptions.set(userId, stream);
        return stream as unknown as PassThrough;
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
        members: new Map(["user-1"].map((id) => [id, {}])),
      } as MeetingData["voiceChannel"],
      guildId: "guild-1",
      channelId: "channel-1",
      audioData: {
        currentSnippets: new Map(),
        audioFiles: [],
      },
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
});
