import { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import {
  ButtonInteraction,
  CommandInteraction,
  Guild,
  TextChannel,
  User,
  VoiceBasedChannel,
} from "discord.js";
import type { SpanContext } from "@opentelemetry/api";
import { AudioData } from "./audio";
import { ChatEntry } from "./chat";
import { Participant } from "./participants";
import type { DictionaryEntry, UserSpeechSettings } from "./db";
import type { TtsQueue } from "../ttsQueue";
import type {
  AutoRecordRule,
  MeetingEndReason,
  MeetingStartReason,
} from "./meetingLifecycle";
import type { ConfigTier, MeetingRuntimeConfig } from "../config/types";

export type LiveVoiceCommandPending = {
  type: "end_meeting";
  userId: string;
  requestedAt: number;
  expiresAt: number;
};

export type LiveVoiceThinkingCueState = {
  activeCount: number;
  timer?: ReturnType<typeof setInterval>;
  loggedStart?: boolean;
};

export interface MeetingData {
  meetingId: string;
  chatLog: ChatEntry[];
  attendance: Set<string>;
  connection: VoiceConnection;
  textChannel: TextChannel;
  voiceChannel: VoiceBasedChannel;
  guildId: string;
  channelId: string;
  audioData: AudioData;
  startTime: Date;
  endTime?: Date;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  creator: User;
  guild: Guild;
  initialInteraction?: ButtonInteraction;
  isAutoRecording: boolean;
  startReason?: MeetingStartReason;
  startTriggeredByUserId?: string;
  autoRecordRule?: AutoRecordRule;
  endReason?: MeetingEndReason;
  endTriggeredByUserId?: string;
  cancelled?: boolean;
  cancellationReason?: string;

  liveAudioPlayer?: AudioPlayer;
  liveVoiceEnabled?: boolean;
  liveVoiceCommandsEnabled?: boolean;
  liveVoiceTtsVoice?: string;
  liveVoiceCommandPending?: LiveVoiceCommandPending;
  liveVoiceThinkingCueState?: LiveVoiceThinkingCueState;
  langfuseParentSpanContext?: SpanContext;

  chatTtsEnabled?: boolean;
  chatTtsVoice?: string;
  chatTtsUserSettings?: Map<string, UserSpeechSettings | null>;
  ttsQueue?: TtsQueue;

  finishing: boolean;
  // Used for functions that are waiting for the meeting to be completely over
  isFinished: Promise<void>;
  setFinished: () => void;
  finished: boolean;

  transcribeMeeting: boolean;
  generateNotes: boolean;
  meetingContext?: string;
  onEndMeeting?: (meeting: MeetingData) => Promise<void> | void;
  subscriptionTier?: ConfigTier;
  runtimeConfig?: MeetingRuntimeConfig;

  finalTranscript?: string;
  transcriptS3Key?: string;
  notesMessageIds?: string[];
  notesChannelId?: string;
  notesVersion?: number;
  notesLastEditedBy?: string;
  notesLastEditedAt?: string;
  notesText?: string;
  meetingName?: string;
  summarySentence?: string;
  summaryLabel?: string;
  participants: Map<string, Participant>;
  audioS3Key?: string;
  chatS3Key?: string;
  tags?: string[];
  dictionaryEntries?: DictionaryEntry[];
  startMessageId?: string;
  summaryMessageId?: string;
  messagesToDelete?: string[];
  leaseOwnerInstanceId?: string;
  leaseHeartbeatTimer?: ReturnType<typeof setInterval>;
}

export interface MeetingSetup {
  interaction: CommandInteraction;
}
