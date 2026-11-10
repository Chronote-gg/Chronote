import { PassThrough } from "node:stream";
import { VoiceConnectionStatus } from "@discordjs/voice";
import type { MeetingData } from "../../../src/types/meeting-data";

export function createMeeting(streams: PassThrough[]) {
  const receiver = {
    packetDiagnostics: new WeakMap(),
    subscriptions: new Map<string, PassThrough>(),
    subscribe: jest.fn((userId: string) => {
      const stream = new PassThrough({ objectMode: true });
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
  } as unknown as MeetingData;
  return { meeting, receiver };
}
