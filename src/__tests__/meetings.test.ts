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

const mockConfig = {
  liveVoice: { mode: "tts_gate" },
  chatTts: { queueLimit: 10, ttsOnlyIdleTimeoutMs: 0 },
};

jest.mock("../services/configService", () => ({
  config: mockConfig,
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
import {
  getSnapshotBoolean,
  getSnapshotString,
} from "../services/unifiedConfigService";
import { createTtsQueue } from "../ttsQueue";
import {
  deleteMeeting,
  initializeMeeting,
  restoreVoiceSessionNickname,
} from "../meetings";
import type { Guild, TextChannel, User, VoiceBasedChannel } from "discord.js";

const buildMembers = (members: Array<{ user: { id: string } }> = []) => ({
  map: <T>(callback: (member: { user: { id: string } }) => T) =>
    members.map(callback),
  has: jest.fn(() => false),
  size: members.length,
});

const buildBotMember = (
  displayName = "Meeting Notes Bot",
  nickname: string | null = null,
) => {
  const originalDisplayName = displayName;
  const botMember = {
    displayName,
    nickname: nickname as string | null,
    setNickname: jest.fn(async (nextNickname: string | null) => {
      botMember.nickname = nextNickname;
      botMember.displayName = nextNickname ?? originalDisplayName;
    }),
  };
  return botMember;
};

const buildMeetingOptions = (botMember: unknown = null) => {
  const guild = {
    id: "guild-1",
    voiceAdapterCreator: {},
    members: { me: botMember },
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
    mockConfig.chatTts.ttsOnlyIdleTimeoutMs = 0;
    jest.mocked(getSnapshotBoolean).mockReturnValue(false);
    jest.mocked(getSnapshotString).mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
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

  it("appends the session status suffix to the current bot display name", async () => {
    const botMember = buildBotMember("Meeting Notes Bot");
    const { guild, voiceChannel, textChannel, creator } =
      buildMeetingOptions(botMember);
    jest.mocked(getSnapshotBoolean).mockReturnValue(true);
    jest.mocked(getSnapshotString).mockReturnValue("(TTS Only)");

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

    expect(botMember.setNickname).toHaveBeenCalledWith(
      "Meeting Notes Bot (TTS Only)",
    );
    expect(meeting.botNicknameBeforeSession).toBeNull();

    await restoreVoiceSessionNickname(meeting);
    expect(botMember.setNickname).toHaveBeenLastCalledWith(null);

    deleteMeeting(meeting.guildId);
  });

  it("does not duplicate an existing session status suffix", async () => {
    const botMember = buildBotMember(
      "Meeting Notes Bot (TTS Only)",
      "Meeting Notes Bot (TTS Only)",
    );
    const { guild, voiceChannel, textChannel, creator } =
      buildMeetingOptions(botMember);
    jest.mocked(getSnapshotBoolean).mockReturnValue(true);
    jest.mocked(getSnapshotString).mockReturnValue("(TTS Only)");

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

    expect(botMember.setNickname).not.toHaveBeenCalled();

    deleteMeeting(meeting.guildId);
  });

  it("ends a TTS-only session after inactivity", async () => {
    jest.useFakeTimers();
    mockConfig.chatTts.ttsOnlyIdleTimeoutMs = 1000;
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
    const connection = jest.mocked(joinVoiceChannel).mock.results[0].value;

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.disconnect).toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalled();
    expect(meeting.finished).toBe(true);
    expect(textChannel.send).toHaveBeenCalledWith(
      expect.stringContaining("after 1 second without speech activity"),
    );
  });

  it("resets the TTS-only inactivity timer when speech activity occurs", async () => {
    jest.useFakeTimers();
    mockConfig.chatTts.ttsOnlyIdleTimeoutMs = 1000;
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
    const connection = jest.mocked(joinVoiceChannel).mock.results[0].value;

    jest.advanceTimersByTime(999);
    meeting.resetTtsOnlyIdleTimer?.();
    jest.advanceTimersByTime(999);
    await Promise.resolve();

    expect(connection.disconnect).not.toHaveBeenCalled();
    expect(textChannel.send).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.disconnect).toHaveBeenCalled();
    expect(textChannel.send).toHaveBeenCalledWith(
      expect.stringContaining("after 1 second without speech activity"),
    );
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
