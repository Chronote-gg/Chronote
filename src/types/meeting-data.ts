import type { RecordingCheckpointCapture } from "../services/recordingCheckpointCapture";
import type {
  CaptureCoverage,
  RecordingCheckpoint,
  RecordingCaptureState,
} from "./recordingCheckpoint";
import type { RecordingLimitState } from "../services/recordingLimitService";
import type { SessionReservation } from "./deploymentControl";
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
import type { MeetingDelivery } from "./meetingDelivery";
import type { MeetingProcessingOutcome } from "./meetingProcessing";
import type { NotesDeliveryTiming } from "./meetingNotesTiming";
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
import type { ChatTtsSpeakerPrefixMode } from "../utils/ttsText";

export type VoiceSessionMode = "meeting" | "tts_only";

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
  reservation?: SessionReservation;
  recordingCheckpoint?: RecordingCheckpoint;
  recordingCapture?: RecordingCheckpointCapture;
  recordingContentTask?: Promise<void>;
  recordingPreservationTask?: Promise<boolean>;
  recordingPreservationNotification?: {
    promise: Promise<void>;
    outcome: "pending" | "acknowledged" | "unknown";
  };
  recordingPreservationFailure?: {
    reason: "storage_preservation" | "ownership_lost";
    stoppedAt: string;
    preservation: "pending" | "confirmed" | "unconfirmed";
    coverage?: CaptureCoverage;
    lastConfirmedCheckpoint?: RecordingCheckpoint;
  };
  recordingCaptureState?: RecordingCaptureState;
  meetingId: string;
  sessionMode?: VoiceSessionMode;
  captureAudio?: boolean;
  recordBotAudio?: boolean;
  storeChatLog?: boolean;
  chatLog: ChatEntry[];
  attendance: Set<string>;
  connection: VoiceConnection;
  textChannel: TextChannel;
  voiceChannel: VoiceBasedChannel;
  guildId: string;
  channelId: string;
  audioData: AudioData;
  startTime: Date;
  /** Actual receive setup time, separate from the stable reservation/history timestamp. */
  captureStartedAt?: Date;
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
  chatTtsSpeakerPrefixMode?: ChatTtsSpeakerPrefixMode;
  chatTtsUserSettings?: Map<string, UserSpeechSettings | null>;
  ttsQueue?: TtsQueue;
  ttsOnlyIdleTimer?: ReturnType<typeof setTimeout>;
  resetTtsOnlyIdleTimer?: () => void;
  chatTtsMonthlyLimitNoticeSent?: boolean;
  botNicknameBeforeSession?: string | null;
  botNicknameChanged?: boolean;

  ownershipSignal?: AbortSignal;
  finalizationFenced?: boolean;
  finalization?: {
    promise: Promise<void>;
    controller: AbortController;
    disposition: "pending" | "durable" | "unresolved";
    preservation?: Promise<boolean>;
    historyDisposition?: "complete" | "cancelled" | "failed";
  };
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
  delivery?: MeetingDelivery;
  notesDeliveryTiming?: NotesDeliveryTiming;
  processing?: MeetingProcessingOutcome;
  historySaved?: boolean;
  recordingLimitNotice?: RecordingLimitState;
  messagesToDelete?: string[];
  leaseOwnerInstanceId?: string;
  leaseHeartbeatTimer?: ReturnType<typeof setInterval>;
}

export interface MeetingSetup {
  interaction: CommandInteraction;
}

/** Plain content and processing state, explicitly prepared for live or recovered notes. */
export type MeetingNotesInput = Pick<
  MeetingData,
  | "meetingId"
  | "guildId"
  | "channelId"
  | "generateNotes"
  | "transcribeMeeting"
  | "startTime"
  | "finalTranscript"
  | "notesText"
  | "processing"
  | "summarySentence"
  | "summaryLabel"
  | "meetingName"
  | "tags"
  | "participants"
  | "attendance"
  | "langfuseParentSpanContext"
> & {
  creator: Pick<User, "id">;
  guild: Pick<Guild, "id" | "name" | "description">;
  voiceChannel: Pick<VoiceBasedChannel, "id" | "name">;
  runtimeConfig?: Pick<
    MeetingRuntimeConfig,
    "modelChoices" | "modelParams" | "dictionary" | "visionCaptions"
  >;
  signal?: AbortSignal;
  notesPrompt?: import("../services/langfusePromptService").ChatPromptResult & {
    promptVisibleRoleIds: string[];
  };
  savedSummary?: {
    prompt: import("../services/savedRecordingPrompt").SavedRecordingPrompt;
    recentMeetingNames: string;
  };
  frozenModels?: Pick<
    import("./recordingContent").SavedRecordingSettings["models"],
    "notes" | "meetingSummary"
  >;
  captureNotice?: string;
  recovered?: true;
};
