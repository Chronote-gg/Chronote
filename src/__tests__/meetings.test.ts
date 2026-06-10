jest.mock("@discordjs/voice", () => ({
  NoSubscriberBehavior: { Pause: "pause" },
  createAudioPlayer: jest.fn(() => ({ state: { status: "idle" } })),
  joinVoiceChannel: jest.fn(() => ({
    receiver: { speaking: { on: jest.fn() } },
    subscribe: jest.fn(),
    on: jest.fn(),
    disconnect: jest.fn(),
    destroy: jest.fn(),
  })),
}));

jest.mock("../audio", () => ({
  openOutputFile: jest.fn(),
  subscribeToUserVoice: jest.fn(),
  userStartTalking: jest.fn(),
  userStopTalking: jest.fn(),
}));

jest.mock("../services/configService", () => ({
  config: {
    liveVoice: { mode: "tts_gate" },
    chatTts: { queueLimit: 10 },
  },
}));

jest.mock("../services/meetingConfigService", () => ({
  resolveMeetingRuntimeConfig: jest.fn(async () => ({})),
}));

jest.mock("../services/unifiedConfigService", () => ({
  getSnapshotBoolean: jest.fn(() => false),
  getSnapshotString: jest.fn(() => undefined),
  resolveConfigSnapshot: jest.fn(async () => ({ values: {} })),
}));

jest.mock("../services/dictionaryService", () => ({
  listDictionaryEntriesService: jest.fn(async () => []),
}));

jest.mock("../ttsQueue", () => ({
  createTtsQueue: jest.fn(() => ({
    enqueue: jest.fn(() => true),
    playCueIfIdle: jest.fn(() => false),
    stopAndClear: jest.fn(),
    size: jest.fn(() => 0),
  })),
}));

jest.mock("../chatTts", () => ({
  maybeSpeakChatMessage: jest.fn(),
}));

jest.mock("../utils/participants", () => ({
  buildParticipantSnapshot: jest.fn(
    async (_guild: unknown, userId: string) => ({
      id: userId,
      username: `user-${userId}`,
    }),
  ),
  formatUserMention: jest.fn((userId: string) => `<@${userId}>`),
  fromMember: jest.fn((member: { user: { id: string; username: string } }) => ({
    id: member.user.id,
    username: member.user.username,
  })),
  fromUser: jest.fn((user: { id: string; username: string }) => ({
    id: user.id,
    username: user.username,
  })),
}));

import { createAudioPlayer, joinVoiceChannel } from "@discordjs/voice";
import {
  openOutputFile,
  subscribeToUserVoice,
  userStartTalking,
  userStopTalking,
} from "../audio";
import { listDictionaryEntriesService } from "../services/dictionaryService";
import { createTtsQueue } from "../ttsQueue";
import { deleteMeeting, initializeMeeting } from "../meetings";
import type { Guild, TextChannel, User, VoiceBasedChannel } from "discord.js";

const buildMembers = (members: Array<{ user: { id: string } }> = []) => ({
  map: <T>(callback: (member: { user: { id: string } }) => T) =>
    members.map(callback),
  has: jest.fn(() => false),
  size: members.length,
});

const buildMeetingOptions = () => {
  const guild = {
    id: "guild-1",
    voiceAdapterCreator: {},
    members: { me: null },
  } as unknown as Guild;
  const voiceChannel = {
    id: "voice-1",
    name: "Voice",
    guild,
    members: buildMembers([{ user: { id: "user-1" } }]),
    createMessageCollector: jest.fn(() => ({ on: jest.fn() })),
  } as unknown as VoiceBasedChannel;
  const textChannel = {
    id: "text-1",
    send: jest.fn(),
  } as unknown as TextChannel;
  const creator = { id: "creator-1" } as User;

  return { guild, voiceChannel, textChannel, creator };
};

describe("initializeMeeting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not create capture or recording plumbing for TTS-only sessions", async () => {
    const { guild, voiceChannel, textChannel, creator } = buildMeetingOptions();

    const meeting = await initializeMeeting({
      sessionMode: "tts_only",
      captureAudio: false,
      recordBotAudio: false,
      storeChatLog: false,
      guild,
      voiceChannel,
      textChannel,
      creator,
      transcribeMeeting: false,
      generateNotes: false,
      chatTtsEnabled: true,
    });

    expect(meeting.sessionMode).toBe("tts_only");
    expect(meeting.captureAudio).toBe(false);
    expect(meeting.recordBotAudio).toBe(false);
    expect(meeting.storeChatLog).toBe(false);
    expect(openOutputFile).not.toHaveBeenCalled();
    expect(subscribeToUserVoice).not.toHaveBeenCalled();
    expect(userStartTalking).not.toHaveBeenCalled();
    expect(userStopTalking).not.toHaveBeenCalled();
    expect(listDictionaryEntriesService).not.toHaveBeenCalled();
    expect(createAudioPlayer).toHaveBeenCalled();
    expect(createTtsQueue).toHaveBeenCalled();
    expect(joinVoiceChannel).toHaveBeenCalledWith(
      expect.objectContaining({ selfDeaf: true }),
    );
    const connection = jest.mocked(joinVoiceChannel).mock.results[0].value;
    expect(connection.receiver.speaking.on).not.toHaveBeenCalled();

    deleteMeeting(meeting.guildId);
  });

  it("keeps capture and recording plumbing for normal meetings", async () => {
    const { guild, voiceChannel, textChannel, creator } = buildMeetingOptions();

    const meeting = await initializeMeeting({
      guild,
      voiceChannel,
      textChannel,
      creator,
      transcribeMeeting: true,
      generateNotes: true,
      chatTtsEnabled: false,
    });

    expect(meeting.sessionMode).toBe("meeting");
    expect(meeting.captureAudio).toBe(true);
    expect(openOutputFile).toHaveBeenCalledWith(meeting);
    expect(subscribeToUserVoice).toHaveBeenCalledWith(meeting, "user-1");
    expect(listDictionaryEntriesService).toHaveBeenCalledWith("guild-1");
    expect(joinVoiceChannel).toHaveBeenCalledWith(
      expect.objectContaining({ selfDeaf: false }),
    );
    const connection = jest.mocked(joinVoiceChannel).mock.results[0].value;
    expect(connection.receiver.speaking.on).toHaveBeenCalledWith(
      "start",
      expect.any(Function),
    );
    expect(connection.receiver.speaking.on).toHaveBeenCalledWith(
      "end",
      expect.any(Function),
    );

    deleteMeeting(meeting.guildId);
  });
});
