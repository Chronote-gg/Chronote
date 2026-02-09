import { MeetingData, MeetingSetup } from "./types/meeting-data";
import {
  ButtonInteraction,
  Guild,
  TextChannel,
  User,
  VoiceBasedChannel,
} from "discord.js";
import {
  NoSubscriberBehavior,
  createAudioPlayer,
  joinVoiceChannel,
} from "@discordjs/voice";
import { DiscordGatewayAdapterCreator } from "@discordjs/voice/dist";
import { AudioSnippet } from "./types/audio";
import {
  openOutputFile,
  subscribeToUserVoice,
  userStartTalking,
  userStopTalking,
} from "./audio";
import {
  MAXIMUM_MEETING_DURATION,
  MAXIMUM_MEETING_DURATION_PRETTY,
} from "./constants";
import { v4 as uuidv4 } from "uuid";
import { ChatEntry } from "./types/chat";
import {
  buildParticipantSnapshot,
  formatUserMention,
  fromMember,
  fromUser,
} from "./utils/participants";
import { config } from "./services/configService";
import { resolveMeetingRuntimeConfig } from "./services/meetingConfigService";
import { listDictionaryEntriesService } from "./services/dictionaryService";
import { createTtsQueue } from "./ttsQueue";
import { maybeSpeakChatMessage } from "./chatTts";
import {
  MEETING_END_REASONS,
  MEETING_START_REASONS,
  type AutoRecordRule,
  type MeetingStartReason,
} from "./types/meetingLifecycle";
import { meetingsStarted } from "./metrics";
import type { ConfigTier } from "./config/types";

const meetings = new Map<string, MeetingData>();

// Since the bot can't be in multiple channels at once, we can just track a single meeting per guild, that's good enough.
// This actually solves a separate issue of having to track meeting by both voice channel and text channel

export function getMeeting(guildId: string) {
  return meetings.get(guildId);
}

export function hasMeeting(guildId: string) {
  return meetings.has(guildId);
}

export function addMeeting(meeting: MeetingData) {
  meetings.set(meeting.guildId, meeting);
}

export function deleteMeeting(guildId: string) {
  meetings.delete(guildId);
}

export function getAllMeetings(): MeetingData[] {
  return Array.from(meetings.values());
}

const meetingSetups = new Map<string, MeetingSetup>();

export function getMeetingSetup(key: string) {
  return meetingSetups.get(key);
}
export function deleteMeetingSetup(key: string) {
  return meetingSetups.delete(key);
}

export interface MeetingInitOptions {
  voiceChannel: VoiceBasedChannel;
  textChannel: TextChannel;
  guild: Guild;
  creator: User;
  transcribeMeeting: boolean;
  generateNotes: boolean;
  meetingContext?: string;
  initialInteraction?: ButtonInteraction;
  isAutoRecording?: boolean;
  startReason?: MeetingStartReason;
  startTriggeredByUserId?: string;
  autoRecordRule?: AutoRecordRule;
  onTimeout?: (meeting: MeetingData) => void;
  tags?: string[];
  liveVoiceEnabled?: boolean;
  liveVoiceCommandsEnabled?: boolean;
  liveVoiceTtsVoice?: string;
  chatTtsEnabled?: boolean;
  chatTtsVoice?: string;
  maxMeetingDurationMs?: number;
  maxMeetingDurationPretty?: string;
  subscriptionTier?: ConfigTier;
  onEndMeeting?: (meeting: MeetingData) => Promise<void> | void;
}

/**
 * Initializes a new meeting with voice recording and chat logging.
 * This is the core function used by both manual and auto-recording features.
 *
 * @param options - Configuration options for the meeting
 * @returns The initialized MeetingData object
 * @throws Error if voice connection fails or if meeting setup encounters issues
 */
export async function initializeMeeting(
  options: MeetingInitOptions,
): Promise<MeetingData> {
  const {
    voiceChannel,
    textChannel,
    guild,
    creator,
    transcribeMeeting,
    generateNotes,
    meetingContext,
    initialInteraction,
    isAutoRecording = false,
    startReason,
    startTriggeredByUserId,
    autoRecordRule,
    onTimeout,
    tags,
    liveVoiceEnabled: liveVoiceOverride,
    liveVoiceCommandsEnabled: liveVoiceCommandsOverride,
    liveVoiceTtsVoice,
    chatTtsEnabled: chatTtsOverride,
    chatTtsVoice,
    maxMeetingDurationMs,
    maxMeetingDurationPretty,
    subscriptionTier,
    onEndMeeting,
  } = options;
  const resolvedStartReason =
    startReason ??
    (isAutoRecording
      ? MEETING_START_REASONS.AUTO_RECORD_CHANNEL
      : MEETING_START_REASONS.MANUAL_COMMAND);

  // Join the voice channel
  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator:
        guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: false, // must be unmuted to play TTS into the channel
    });
  } catch (error) {
    console.error("Failed to join voice channel:", error);
    throw new Error(
      `Failed to join voice channel: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const receiver = connection.receiver;
  const attendance: Set<string> = new Set<string>();
  const liveVoiceEnabled =
    config.liveVoice.mode === "tts_gate" && liveVoiceOverride !== false;
  const liveVoiceCommandsEnabled =
    config.liveVoice.mode === "tts_gate" && liveVoiceCommandsOverride === true;
  const chatTtsEnabled = chatTtsOverride ?? false;
  const botAudioEnabled =
    liveVoiceEnabled || chatTtsEnabled || liveVoiceCommandsEnabled;
  const liveAudioPlayer = botAudioEnabled
    ? createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
        },
      })
    : undefined;

  if (liveAudioPlayer) {
    connection.subscribe(liveAudioPlayer);
  }

  let setFinished: ((val?: void) => void) | undefined = undefined;
  const isFinished = new Promise<void>((resolve) => {
    setFinished = resolve;
  });

  const meeting: MeetingData = {
    meetingId: uuidv4(),
    chatLog: [],
    attendance,
    connection,
    textChannel,
    audioData: {
      audioFiles: [],
      currentSnippets: new Map<string, AudioSnippet>(),
    },
    voiceChannel,
    guildId: guild.id,
    channelId: textChannel.id,
    startTime: new Date(),
    creator,
    liveAudioPlayer,
    liveVoiceEnabled,
    liveVoiceCommandsEnabled,
    liveVoiceTtsVoice,
    chatTtsEnabled,
    chatTtsVoice,
    chatTtsUserSettings: new Map(),
    isFinished,
    setFinished: () => setFinished && setFinished(),
    finishing: false,
    finished: false,
    guild,
    initialInteraction,
    transcribeMeeting,
    generateNotes,
    meetingContext,
    onEndMeeting: onEndMeeting ?? onTimeout,
    isAutoRecording,
    startReason: resolvedStartReason,
    startTriggeredByUserId,
    autoRecordRule,
    participants: new Map(),
    tags,
    subscriptionTier,
  };

  if (liveAudioPlayer) {
    meeting.ttsQueue = createTtsQueue(meeting, liveAudioPlayer);
  }

  // Open output file for audio recording
  openOutputFile(meeting);

  // Set up error handling for the connection
  connection.on("error", (error) => {
    console.error("Voice connection error:", error);
    textChannel.send(
      `There was an error trying to join the voice channel${isAutoRecording ? " for auto-recording" : ""}.`,
    );
  });

  // Snapshot participants for initial members
  await Promise.all(
    voiceChannel.members.map(async (member) => {
      const participant = await buildParticipantSnapshot(
        voiceChannel.guild,
        member.user.id,
      );
      if (participant) {
        meeting.participants.set(member.user.id, participant);
        attendance.add(formatUserMention(member.user.id));
      }
    }),
  );

  // Subscribe to initial members' voice
  await Promise.all(
    voiceChannel.members.map((member) =>
      subscribeToUserVoice(meeting, member.user.id),
    ),
  );

  // Set up speaking event handlers
  receiver.speaking.on("start", (userId) => {
    userStartTalking(meeting, userId);
  });

  receiver.speaking.on("end", (userId) => {
    userStopTalking(meeting, userId);
  });

  // Set up chat collector
  const collector = voiceChannel.createMessageCollector();
  collector.on("collect", (message) => {
    if (message.author.bot) return;

    const participant =
      meeting.participants.get(message.author.id) ??
      (message.member ? fromMember(message.member) : fromUser(message.author));

    meeting.participants.set(message.author.id, participant);

    const attachments =
      message.attachments.size > 0
        ? Array.from(message.attachments.values()).map((attachment) => ({
            id: attachment.id,
            name: attachment.name ?? "attachment",
            size: attachment.size,
            url: attachment.url,
            proxyUrl: attachment.proxyURL,
            contentType: attachment.contentType ?? undefined,
            width: attachment.width ?? undefined,
            height: attachment.height ?? undefined,
            durationSeconds: attachment.duration ?? undefined,
            description: attachment.description ?? undefined,
            ephemeral: attachment.ephemeral ?? undefined,
          }))
        : undefined;

    const entry: ChatEntry = {
      type: "message",
      source: "chat",
      user: participant,
      channelId: message.channelId,
      content: message.content,
      attachments,
      messageId: message.id,
      timestamp: new Date(message.createdTimestamp).toISOString(),
    };

    meeting.chatLog.push(entry);
    meeting.attendance.add(formatUserMention(message.author.id));

    void maybeSpeakChatMessage(meeting, message, entry);
  });

  // Add meeting to the global map
  addMeeting(meeting);
  meetingsStarted.inc();

  try {
    meeting.runtimeConfig = await resolveMeetingRuntimeConfig({
      guildId: meeting.guildId,
      channelId: meeting.voiceChannel.id,
      userId: meeting.creator.id,
      tier: subscriptionTier,
    });
  } catch (error) {
    console.warn("Failed to resolve meeting runtime config:", error);
  }

  try {
    meeting.dictionaryEntries = await listDictionaryEntriesService(
      meeting.guildId,
    );
  } catch (error) {
    console.warn("Failed to load dictionary entries:", error);
  }

  // Set a timer to automatically end the meeting after the specified duration
  if (onTimeout) {
    const durationLimitMs = maxMeetingDurationMs ?? MAXIMUM_MEETING_DURATION;
    const durationPretty =
      maxMeetingDurationPretty ?? MAXIMUM_MEETING_DURATION_PRETTY;
    meeting.timeoutTimer = setTimeout(() => {
      textChannel.send(
        `Ending ${isAutoRecording ? "auto-recorded " : ""}meeting due to maximum meeting time of ${durationPretty} having been reached.`,
      );
      meeting.endReason = MEETING_END_REASONS.TIMEOUT;
      onTimeout(meeting);
    }, durationLimitMs);
  }

  return meeting;
}
