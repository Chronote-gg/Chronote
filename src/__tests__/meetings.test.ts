/** @jest-environment node */
jest.mock("../services/recordingLimitService", () => ({
  notifyRecordingLimit: jest.fn(),
}));
// The lease, voice join and failure unwinding are meetingStart's and tested there;
// this suite drives what meetings.ts builds once voice is Ready.
jest.mock("../services/meetingStart", () => ({
  startMeetingSession: jest.fn(
    async (options: import("../meetings").MeetingInitOptions) => {
      // Loaded at call time so the meeting lands in the same live map the test reads.
      const { buildMeetingSession, sessionCapturesAudio } =
        jest.requireActual<typeof import("../meetings")>("../meetings");
      const reservedAt = options.reservedAt ?? Date.now();
      const sessionMode = options.sessionMode ?? "meeting";
      const shared = {
        guildId: options.guild.id,
        meetingId: options.meetingId ?? "synthetic-meeting",
        ownerInstanceId: "fixture",
        executionVersion: 1,
        voiceOperationAttemptId: "attempt",
        reservedAt,
      };
      const reservation =
        sessionMode === "meeting"
          ? {
              ...shared,
              sessionMode,
              historyKey: {
                guildId: options.guild.id,
                channelId_timestamp: `${options.voiceChannel.id}#${new Date(reservedAt).toISOString()}`,
              },
            }
          : { ...shared, sessionMode };
      const connection = jest.requireMock("@discordjs/voice").joinVoiceChannel({
        channelId: options.voiceChannel.id,
        guildId: options.guild.id,
        adapterCreator: options.guild.voiceAdapterCreator,
        selfDeaf: !sessionCapturesAudio(options),
        selfMute: false,
      });
      return buildMeetingSession(
        options,
        reservation,
        connection,
        options.startSignal ?? new AbortController().signal,
        { ownershipSignal: new AbortController().signal },
      );
    },
  ),
}));
jest.mock("../services/meetingClose", () => ({
  closeMeeting: jest.fn(async () => undefined),
}));
import { notifyRecordingLimit } from "../services/recordingLimitService";
import { startMeetingSession } from "../services/meetingStart";
import { closeMeeting } from "../services/meetingClose";
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
  closeFailedInitializationOutput: jest.fn(async () => true),
  subscribeToUserVoice: jest.fn(),
  userStartTalking: jest.fn(),
  userStopTalking: jest.fn(),
}));

const mockConfig = {
  analytics: { posthogKey: "" },
  liveVoice: { mode: "tts_gate" },
  chatTts: { queueLimit: 10, ttsOnlyIdleTimeoutMs: 0 },
};

jest.mock("../services/configService", () => ({
  config: {
    ...jest.requireActual("../services/configService").config,
    ...mockConfig,
  },
}));

jest.mock("../services/meetingConfigService", () => ({
  resolveMeetingRuntimeConfig: jest.fn(
    jest.requireActual("../services/meetingConfigService")
      .resolveMeetingRuntimeConfig,
  ),
}));

jest.mock("../services/unifiedConfigService", () => ({
  ...jest.requireActual("../services/unifiedConfigService"),
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
  maybeSpeakChatMessage: jest.fn(async () => undefined),
}));

jest.mock("../utils/participants", () => ({
  ...jest.requireActual("../utils/participants"),
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

jest.mock("../services/contextService", () => ({
  ...jest.requireActual("../services/contextService"),
  collectMeetingContext: jest.fn(async () => ({
    availability: "available",
    data: {},
  })),
}));
jest.mock("../services/meetingNameService", () => ({
  listRecentMeetingNamesForPrompt: jest.fn(async () => ""),
}));
jest.mock("../services/savedRecordingPrompt", () => ({
  ...jest.requireActual("../services/savedRecordingPrompt"),
  snapshotRecordingPrompt: jest.fn(async (name, type, label) => ({
    name,
    type,
    label,
    version: 1,
    template:
      type === "text"
        ? "{{transcript}}"
        : [{ role: "user", content: "{{transcript}}" }],
  })),
}));
import {
  Collection,
  PermissionsBitField,
  PermissionFlagsBits,
  Routes,
} from "discord.js";
import { resolveMeetingRuntimeConfig } from "../services/meetingConfigService";
import { startRecordingContentCheckpoint } from "../services/recordingContentService";
import { completionSnapshot } from "../services/meetingCompletionPolicyService";
import { generationContextSchema } from "../types/recordingContent";
import type { CheckpointArtifactInput } from "../types/recordingCheckpoint";
import type { MeetingData } from "../types/meeting-data";
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
  addMeeting,
  deleteMeeting,
  initializeMeeting,
  stopMeetingInitializations,
  getStartingMeetingId,
  restoreVoiceSessionNickname,
  getMeeting,
} from "../meetings";
import type { Guild, TextChannel, User, VoiceBasedChannel } from "discord.js";

const buildMembers = (members: Array<{ user: { id: string } }> = []) =>
  new Collection(members.map((member) => [member.user.id, member]));

const buildBotMember = (
  displayName = "Meeting Notes Bot",
  nickname: string | null = null,
) => {
  const originalDisplayName = displayName;
  const botMember = {
    permissions: new PermissionsBitField(PermissionFlagsBits.ChangeNickname),
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
    name: "Generated guild",
    roles: new Collection(),
    scheduledEvents: new Collection(),
    channels: new Collection(),
    client: { rest: { patch: jest.fn(async () => ({})) } },
    voiceAdapterCreator: {},
    members: { me: botMember },
  } as unknown as Guild;
  const voiceChannel = {
    id: "voice-1",
    name: "Voice",
    guild,
    members: buildMembers([{ user: { id: "user-1" } }]),
    createMessageCollector: jest.fn(() => ({ on: jest.fn(), stop: jest.fn() })),
  } as unknown as VoiceBasedChannel;
  const textChannel = {
    id: "text-1",
    send: jest.fn(),
  } as unknown as TextChannel;
  const creator = { id: "creator-1" } as User;

  return { guild, voiceChannel, textChannel, creator };
};

describe("voice connection errors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const live = getMeeting("guild-1");
    if (live) deleteMeeting(live);
  });
  const connectionErrorHandler = () => {
    const connection = jest.mocked(joinVoiceChannel).mock.results[0].value;
    const call = jest
      .mocked(connection.on)
      .mock.calls.find(([event]: [string]) => event === "error");
    return call![1] as (error: Error) => void;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("a failed error notice is sent once and logged without its details", async () => {
    const options = buildMeetingOptions();
    jest
      .mocked(options.textChannel.send)
      .mockRejectedValue(new Error("private notification detail"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    const meeting = await initializeMeeting({
      ...options,
      transcribeMeeting: false,
      generateNotes: false,
    });
    connectionErrorHandler()(new Error("synthetic connection fault"));
    await settle();
    expect(options.textChannel.send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Voice error notification failed:", {
      stage: "connection-error-notification",
      meetingId: meeting.meetingId,
    });
    deleteMeeting(meeting);
    jest.restoreAllMocks();
  });

  it("an error after the meeting is finishing sends no notice", async () => {
    const options = buildMeetingOptions();
    jest.spyOn(console, "error").mockImplementation(() => {});
    const meeting = await initializeMeeting({
      ...options,
      transcribeMeeting: false,
      generateNotes: false,
    });
    meeting.finishing = true;
    connectionErrorHandler()(new Error("synthetic late fault"));
    await settle();
    expect(options.textChannel.send).not.toHaveBeenCalled();
    deleteMeeting(meeting);
    jest.restoreAllMocks();
  });

  it("a failed initial voice subscription fails the start", async () => {
    const failure = new Error("synthetic initial subscription failure");
    jest.mocked(subscribeToUserVoice).mockRejectedValueOnce(failure);
    await expect(
      initializeMeeting({
        ...buildMeetingOptions(),
        transcribeMeeting: false,
        generateNotes: false,
      }),
    ).rejects.toBe(failure);
  });
});

/** The TTS-only session closed on its idle timeout and told the text channel why. */
function expectClosedForTtsInactivity(
  meeting: unknown,
  textChannel: { send: unknown },
) {
  expect(closeMeeting).toHaveBeenCalledWith(meeting, {
    endReason: "timeout",
  });
  expect(textChannel.send).toHaveBeenCalledWith(
    expect.stringContaining("after 1 second without speech activity"),
  );
}

describe("initializeMeeting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const live = getMeeting("guild-1");
    if (live) deleteMeeting(live);
    mockConfig.chatTts.ttsOnlyIdleTimeoutMs = 0;
    jest.mocked(getSnapshotBoolean).mockReturnValue(false);
    jest.mocked(getSnapshotString).mockReturnValue(undefined);
  });

  it.each([false, true])(
    "first actual checkpoint has original config before capture (auto=%s)",
    async (isAutoRecording) => {
      const artifacts: CheckpointArtifactInput[] = [];
      jest
        .mocked(subscribeToUserVoice)
        .mockImplementationOnce(async (meeting) => {
          expect(completionSnapshot(meeting)).toBeDefined();
          meeting.captureStartedAt = new Date();
          meeting.recordingCapture = {
            queueContent: (artifact: CheckpointArtifactInput) => {
              artifacts.push(artifact);
              return true;
            },
          } as MeetingData["recordingCapture"];
          startRecordingContentCheckpoint(meeting);
          await meeting.recordingContentTask;
        });
      const meeting = await initializeMeeting({
        ...buildMeetingOptions(),
        transcribeMeeting: true,
        generateNotes: true,
        isAutoRecording,
      });
      const first = generationContextSchema.parse(
        JSON.parse(Buffer.from(artifacts[0].bytes).toString()),
      );
      expect(first.settings.availability).toBe("available");
      if (first.settings.availability !== "available")
        throw new Error("Original settings missing");
      expect(first.settings.value.transcription).toEqual(
        meeting.runtimeConfig!.transcription,
      );
      expect(first.settings.value.autoCompletion).toEqual(
        completionSnapshot(meeting)!.policy,
      );
      expect(first.creatorId).toBe("creator-1");
    },
  );

  it("held config resolution starts neither capture nor starting-history publication", async () => {
    let release!: () => void;
    const runtime = await jest
      .requireActual("../services/meetingConfigService")
      .resolveMeetingRuntimeConfig({
        guildId: "guild-1",
        channelId: "voice-1",
        userId: "creator-1",
      });
    jest.mocked(resolveMeetingRuntimeConfig).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(runtime);
        }),
    );
    const starting = initializeMeeting({
      ...buildMeetingOptions(),
      transcribeMeeting: true,
      generateNotes: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(openOutputFile).not.toHaveBeenCalled();
      expect(subscribeToUserVoice).not.toHaveBeenCalled();
    } finally {
      release();
      await starting;
    }
    expect(subscribeToUserVoice).toHaveBeenCalledTimes(1);
  });

  it("failed original config resolution fails the start before capture", async () => {
    jest
      .mocked(resolveMeetingRuntimeConfig)
      .mockRejectedValueOnce(new Error("original config unavailable"));
    await expect(
      initializeMeeting({
        ...buildMeetingOptions(),
        transcribeMeeting: true,
        generateNotes: true,
      }),
    ).rejects.toThrow("original config unavailable");
    expect(openOutputFile).not.toHaveBeenCalled();
    expect(subscribeToUserVoice).not.toHaveBeenCalled();
  });

  it("an idle voice-only session ends through close and then posts its notice", async () => {
    jest.useFakeTimers();
    mockConfig.chatTts.ttsOnlyIdleTimeoutMs = 1000;
    const options = buildMeetingOptions();
    let finishClose!: () => void;
    jest.mocked(closeMeeting).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const meeting = await initializeMeeting({
      ...options,
      sessionMode: "tts_only",
      transcribeMeeting: false,
      generateNotes: false,
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(closeMeeting).toHaveBeenCalledWith(meeting, {
      endReason: "timeout",
    });
    expect(options.textChannel.send).not.toHaveBeenCalled();
    finishClose();
    await jest.advanceTimersByTimeAsync(0);
    expect(options.textChannel.send).toHaveBeenCalledWith(
      expect.stringContaining("after 1 second without speech activity"),
    );
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  it("stable concurrent initialization retries share one reservation and one join", async () => {
    const options = {
      ...buildMeetingOptions(),
      meetingId: "stable-retry",
      reservedAt: 100,
      transcribeMeeting: true,
      generateNotes: true,
    };
    const first = initializeMeeting(options);
    const second = initializeMeeting(options);
    expect(second).toBe(first);
    expect(await second).toBe(await first);
    expect(startMeetingSession).toHaveBeenCalledTimes(1);
    expect(joinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  it("ends at the captured cap before awaiting upgrade eligibility", async () => {
    jest.useFakeTimers();
    jest.mocked(notifyRecordingLimit).mockReturnValue(new Promise(() => {}));
    const options = buildMeetingOptions();
    const onTimeout = jest.fn(() => {
      expect(notifyRecordingLimit).not.toHaveBeenCalled();
    });
    const meeting = await initializeMeeting({
      ...options,
      transcribeMeeting: false,
      generateNotes: false,
      maxMeetingDurationMs: 90 * 60000,
      maxMeetingDurationPretty: "90 minutes",
      onTimeout,
    });
    jest.advanceTimersByTime(90 * 60000);
    expect(onTimeout).toHaveBeenCalledWith(meeting);
    expect(meeting.endReason).toBe("timeout");
    expect(notifyRecordingLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        limitType: "meeting_duration",
        limitSurface: "duration_stop",
        outcome: "ended_session",
        limitMinutes: 90,
        userId: "creator-1",
      }),
      options.textChannel,
      meeting.recordingLimitNotice,
    );
    expect(meeting.recordingLimitNotice?.pending).toBeDefined();
    expect(options.textChannel.send).not.toHaveBeenCalled();
    deleteMeeting(meeting);
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
    expect(connection.on).not.toHaveBeenCalledWith(
      "transitioned",
      expect.any(Function),
    );

    deleteMeeting(meeting);
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

    const giveUp = new AbortController();
    await expect(
      restoreVoiceSessionNickname(meeting, giveUp.signal),
    ).resolves.toBe(true);
    expect(guild.client.rest.patch).toHaveBeenCalledWith(
      Routes.guildMember("guild-1", "@me"),
      { body: { nick: null }, signal: giveUp.signal },
    );

    deleteMeeting(meeting);
  });

  it("a restore the caller gave up on before it ran sends no request", async () => {
    const botMember = buildBotMember("Meeting Notes Bot");
    const options = buildMeetingOptions(botMember);
    jest.mocked(getSnapshotBoolean).mockReturnValue(true);
    jest.mocked(getSnapshotString).mockReturnValue("(Recording)");
    const meeting = await initializeMeeting({
      ...options,
      transcribeMeeting: false,
      generateNotes: false,
    });
    const giveUp = new AbortController();
    giveUp.abort();

    await expect(
      restoreVoiceSessionNickname(meeting, giveUp.signal),
    ).rejects.toThrow();
    expect(options.guild.client.rest.patch).not.toHaveBeenCalled();
    deleteMeeting(meeting);
  });

  it("a missing nickname permission skips the change and still starts", async () => {
    const botMember = buildBotMember("Meeting Notes Bot");
    botMember.permissions = new PermissionsBitField();
    jest.mocked(getSnapshotBoolean).mockReturnValue(true);
    jest.mocked(getSnapshotString).mockReturnValue("(Recording)");
    const meeting = await initializeMeeting({
      ...buildMeetingOptions(botMember),
      transcribeMeeting: false,
      generateNotes: false,
    });
    expect(botMember.setNickname).not.toHaveBeenCalled();
    deleteMeeting(meeting);
  });

  it("a nickname change with an unknown outcome fails the start", async () => {
    const botMember = buildBotMember("Meeting Notes Bot");
    botMember.setNickname.mockRejectedValueOnce(
      Object.assign(new Error("final forbidden after a possible reset"), {
        status: 403,
      }),
    );
    jest.mocked(getSnapshotBoolean).mockReturnValue(true);
    jest.mocked(getSnapshotString).mockReturnValue("(Recording)");
    await expect(
      initializeMeeting({
        ...buildMeetingOptions(botMember),
        transcribeMeeting: false,
        generateNotes: false,
      }),
    ).rejects.toThrow();
    expect(botMember.setNickname).toHaveBeenCalledTimes(1);
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

    deleteMeeting(meeting);
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

    await jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    expectClosedForTtsInactivity(meeting, textChannel);
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

    await jest.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();

    expectClosedForTtsInactivity(meeting, textChannel);
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
    deleteMeeting(meeting);
  });
  it("cancelled initialization does not dispatch nickname or dictionary after held runtime config", async () => {
    const runtime = jest.requireMock(
      "../services/meetingConfigService",
    ).resolveMeetingRuntimeConfig;
    let release!: () => void;
    let started!: () => void;
    const dispatched = new Promise<void>((done) => {
      started = done;
    });
    runtime.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((done) => {
        release = done;
      });
      return {};
    });
    const bot = buildBotMember("Synthetic Bot");
    jest.mocked(getSnapshotBoolean).mockReturnValue(true);
    jest.mocked(getSnapshotString).mockReturnValue("(recording)");
    const controller = new AbortController();
    const pending = initializeMeeting({
      ...buildMeetingOptions(bot),
      startSignal: controller.signal,
      transcribeMeeting: true,
      generateNotes: true,
    });
    const rejected = expect(pending).rejects.toThrow("synthetic stop");
    await dispatched;
    controller.abort(new Error("synthetic stop"));
    release();
    await rejected;
    expect(bot.setNickname).not.toHaveBeenCalled();
    expect(listDictionaryEntriesService).not.toHaveBeenCalled();
  });

  it("shutdown aborts a held start, waits for it and refuses later starts", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let started!: (signal: AbortSignal | undefined) => void;
    const dispatched = new Promise<AbortSignal | undefined>((done) => {
      started = done;
    });
    jest.mocked(startMeetingSession).mockImplementationOnce(async (options) => {
      started(options.startSignal);
      await held;
      options.startSignal?.throwIfAborted();
      throw new Error("unreachable");
    });
    const options = {
      ...buildMeetingOptions(),
      meetingId: "held-start",
      transcribeMeeting: true,
      generateNotes: true,
    };
    const initialization = initializeMeeting(options);
    const result = initialization.catch(() => undefined);
    const signal = await dispatched;
    expect(getStartingMeetingId("guild-1")).toBe("held-start");
    let settled = false;
    const drain = stopMeetingInitializations().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    release();
    await result;
    await drain;
    expect(getStartingMeetingId("guild-1")).toBeUndefined();
    await expect(
      initializeMeeting({ ...options, meetingId: "late-start" }),
    ).rejects.toThrow();
    expect(startMeetingSession).toHaveBeenCalledTimes(1);
  });
});

describe("deleteMeeting", () => {
  it("removes only the meeting it is given", () => {
    const first = { guildId: "guild-live" } as MeetingData;
    const second = { guildId: "guild-live" } as MeetingData;
    addMeeting(first);
    addMeeting(second);
    deleteMeeting(first);
    expect(getMeeting("guild-live")).toBe(second);
    deleteMeeting(second);
    expect(getMeeting("guild-live")).toBeUndefined();
  });
});
