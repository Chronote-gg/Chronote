import {
  reservationTimingReceipt,
  freezeCompletionPolicy,
} from "./services/meetingCompletionPolicyService";
import {
  getMeetingProcessingSignal,
  runMeetingNoticeMutation,
  stopMeetingProcessing,
  areMeetingNoticesSettled,
} from "./services/meetingProcessingLifetime";
import { notifyRecordingLimit } from "./services/recordingLimitService";
import { MeetingData } from "./types/meeting-data";
import {
  ButtonInteraction,
  DiscordAPIError,
  Guild,
  TextChannel,
  User,
  VoiceBasedChannel,
  PermissionFlagsBits,
} from "discord.js";
import {
  NoSubscriberBehavior,
  createAudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { SessionReservation } from "./types/meetingHistoryTransition";
import type { AcquireSessionLeaseInput } from "./services/meetingLease";
import { startMeetingSession } from "./services/meetingStart";
import { AudioSnippet } from "./types/audio";
import {
  openOutputFile,
  closeFailedInitializationOutput,
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
import {
  getSnapshotBoolean,
  getSnapshotString,
  resolveConfigSnapshot,
} from "./services/unifiedConfigService";
import { listDictionaryEntriesService } from "./services/dictionaryService";
import { createTtsQueue } from "./ttsQueue";
import { maybeSpeakChatMessage } from "./chatTts";
import { CONFIG_KEYS } from "./config/keys";
import {
  MEETING_END_REASONS,
  MEETING_START_REASONS,
  type AutoRecordRule,
  type MeetingStartReason,
} from "./types/meetingLifecycle";
import { meetingsStarted } from "./metrics";
import { captureEvent } from "./services/analyticsService";
import type { ConfigTier } from "./config/types";
import type { ChatTtsSpeakerPrefixMode } from "./utils/ttsText";
import { DEFAULT_CHAT_TTS_SPEAKER_PREFIX_MODE as DEFAULT_PREFIX_MODE } from "./utils/ttsText";
import { resolveMeetingActorId } from "./utils/meetingLifecycle";

const meetings = new Map<string, MeetingData>();
const meetingInitializations = new Map<
  string,
  { promise: Promise<MeetingData>; controller: AbortController }
>();
let initializationsClosed = false;
/** The meeting a start still in progress in this process is building for the server, if any. */
export function getStartingMeetingId(guildId: string): string | undefined {
  const prefix = `${guildId}:`;
  for (const key of meetingInitializations.keys())
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  return undefined;
}
export async function stopMeetingInitializations(): Promise<void> {
  initializationsClosed = true;
  const pending = [...meetingInitializations.values()];
  for (const { controller } of pending)
    controller.abort(new Error("Meeting initialization interrupted"));
  await Promise.allSettled(pending.map(({ promise }) => promise));
}

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

/** Removes only this meeting, so a newer capture in the same server stays live. */
export function deleteMeeting(meeting: MeetingData) {
  clearTtsOnlyIdleTimeout(meeting);
  if (meetings.get(meeting.guildId) === meeting)
    meetings.delete(meeting.guildId);
}

export function getAllMeetings(): MeetingData[] {
  return Array.from(meetings.values());
}

export interface MeetingInitOptions {
  meetingId?: string;
  reservedAt?: number;
  suppressionCheck?: { channelId: string; expectedVersion?: number };
  startSignal?: AbortSignal;
  sessionMode?: "meeting" | "tts_only";
  captureAudio?: boolean;
  recordBotAudio?: boolean;
  storeChatLog?: boolean;
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
  chatTtsSpeakerPrefixMode?: ChatTtsSpeakerPrefixMode;
  maxMeetingDurationMs?: number;
  maxMeetingDurationPretty?: string;
  subscriptionTier?: ConfigTier;
  onEndMeeting?: (meeting: MeetingData) => Promise<void> | void;
}

const DISCORD_NICKNAME_MAX_LENGTH = 32;

function buildVoiceSessionNickname(displayName: string, suffix: string) {
  const trimmedName = displayName.trim();
  const trimmedSuffix = suffix.trim();
  if (!trimmedName || !trimmedSuffix) return undefined;
  if (trimmedName.endsWith(trimmedSuffix)) {
    return trimmedName.slice(0, DISCORD_NICKNAME_MAX_LENGTH);
  }

  const separator = " ";
  const maxNameLength =
    DISCORD_NICKNAME_MAX_LENGTH - trimmedSuffix.length - separator.length;
  if (maxNameLength <= 0) {
    return trimmedSuffix.slice(0, DISCORD_NICKNAME_MAX_LENGTH);
  }

  const baseName = trimmedName.slice(0, maxNameLength).trimEnd();
  return `${baseName}${separator}${trimmedSuffix}`.slice(
    0,
    DISCORD_NICKNAME_MAX_LENGTH,
  );
}

async function applyVoiceSessionNickname(
  meeting: MeetingData,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  try {
    const snapshot = await resolveConfigSnapshot({
      guildId: meeting.guildId,
      channelId: meeting.voiceChannel.id,
      tier: meeting.subscriptionTier,
    });
    signal.throwIfAborted();
    const enabled = getSnapshotBoolean(
      snapshot,
      CONFIG_KEYS.chatTts.statusNicknameEnabled,
    );
    if (!enabled) return;

    const nicknameKey =
      meeting.sessionMode === "tts_only"
        ? CONFIG_KEYS.chatTts.statusNicknameTtsOnly
        : CONFIG_KEYS.chatTts.statusNicknameRecording;
    const nicknameSuffix = getSnapshotString(snapshot, nicknameKey, {
      trim: true,
    });
    const botMember = meeting.guild.members.me;
    if (!nicknameSuffix || !botMember) return;
    // A local permission refusal issues no request and cannot have changed the nickname.
    if (!botMember.permissions.has(PermissionFlagsBits.ChangeNickname)) return;

    const nextNickname = buildVoiceSessionNickname(
      botMember.displayName,
      nicknameSuffix,
    );
    if (!nextNickname) return;
    if (botMember.nickname === nextNickname) return;

    meeting.botNicknameBeforeSession = botMember.nickname ?? null;
    await runMeetingNoticeMutation(
      meeting,
      async () => {
        await botMember.setNickname(nextNickname);
        meeting.botNicknameChanged = true;
      },
      () => false,
    ); // REST can replay network failures/5xx before a final 4xx; that outcome stays unknown.
    getMeetingProcessingSignal(meeting).throwIfAborted();
  } catch (error) {
    getMeetingProcessingSignal(meeting).throwIfAborted();
    signal.throwIfAborted();
    console.warn("Failed to update bot session nickname.", error);
  }
}

export async function restoreVoiceSessionNickname(
  meeting: MeetingData,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!meeting.botNicknameChanged) return true;
  signal?.throwIfAborted();
  try {
    const botMember = meeting.guild.members.me;
    if (!botMember) return false;
    await botMember.setNickname(meeting.botNicknameBeforeSession ?? null);
    meeting.botNicknameChanged = false;
    return true;
  } catch (error) {
    console.warn("Failed to restore bot session nickname.", error);
    return false;
  }
}

function formatIdleTimeoutDuration(timeoutMs: number) {
  const totalSeconds = Math.max(Math.round(timeoutMs / 1000), 1);
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const totalMinutes = Math.max(Math.round(totalSeconds / 60), 1);
  return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
}

function clearTtsOnlyIdleTimeout(meeting: MeetingData) {
  if (!meeting.ttsOnlyIdleTimer) return;
  clearTimeout(meeting.ttsOnlyIdleTimer);
  meeting.ttsOnlyIdleTimer = undefined;
}

export function resetTtsOnlyIdleTimeout(meeting: MeetingData) {
  clearTtsOnlyIdleTimeout(meeting);
  const timeoutMs = config.chatTts.ttsOnlyIdleTimeoutMs ?? 0;
  if (
    meeting.sessionMode !== "tts_only" ||
    meeting.finishing ||
    meeting.finished ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return;
  }

  meeting.ttsOnlyIdleTimer = setTimeout(() => {
    void (async () => {
      if (
        meeting.finishing ||
        meeting.finished ||
        meetings.get(meeting.guildId) !== meeting
      ) {
        return;
      }
      // Loaded on use: close imports this module.
      const { closeMeeting } = await import("./services/meetingClose");
      await closeMeeting(meeting, { endReason: MEETING_END_REASONS.TIMEOUT });
      await Promise.resolve(
        meeting.textChannel.send(
          `TTS-only session ended after ${formatIdleTimeoutDuration(timeoutMs)} without speech activity. No recording or transcription was active.`,
        ),
      ).catch((error) => {
        console.warn("Failed to send TTS-only idle timeout notice.", error);
      });
    })().catch((error) => {
      console.warn("TTS-only idle close failed.", error);
    });
  }, timeoutMs);
}

/**
 * Initializes a new meeting with voice recording and chat logging.
 * This is the core function used by both manual and auto-recording features.
 *
 * @param options - Configuration options for the meeting
 * @returns The initialized MeetingData object
 * @throws Error if voice connection fails or if meeting setup encounters issues
 */
export function initializeMeeting(
  options: MeetingInitOptions,
): Promise<MeetingData> {
  const meetingId = options.meetingId ?? uuidv4();
  const key = `${options.guild.id}:${meetingId}`;
  const pending = meetingInitializations.get(key);
  if (pending) return pending.promise;
  if (initializationsClosed)
    return Promise.reject(
      new Error("Meeting initialization admission is closed"),
    );
  const existing = getMeeting(options.guild.id);
  if (existing?.meetingId === meetingId && !existing.finished)
    return Promise.resolve(existing);
  const controller = new AbortController();
  const startSignal = AbortSignal.any([
    controller.signal,
    ...(options.startSignal ? [options.startSignal] : []),
  ]);
  let resolve!: (meeting: MeetingData | PromiseLike<MeetingData>) => void;
  let reject!: (error: unknown) => void;
  const initialization = new Promise<MeetingData>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  meetingInitializations.set(key, { promise: initialization, controller });
  void initialization.then(
    () => meetingInitializations.delete(key),
    () => meetingInitializations.delete(key),
  );
  try {
    resolve(startMeetingSession({ ...options, meetingId, startSignal }));
  } catch (error) {
    reject(error);
  }
  return initialization;
}
/** The lease and initial history row a start writes, shared by both start paths. */
export function sessionLeaseInput(
  options: MeetingInitOptions & { meetingId: string },
): AcquireSessionLeaseInput {
  const observedAt = Date.now();
  const reservedAt = options.reservedAt ?? observedAt;
  const timingReceipt = reservationTimingReceipt(reservedAt, observedAt);
  const meetingId = options.meetingId;
  const timestamp = new Date(reservedAt).toISOString();
  const shared = {
    guildId: options.guild.id,
    meetingId,
    voiceChannelId: options.voiceChannel.id,
    voiceChannelName: options.voiceChannel.name,
    textChannelId: options.textChannel.id,
    isAutoRecording: options.isAutoRecording ?? false,
    startReason: options.startReason,
    startTriggeredByUserId: options.startTriggeredByUserId,
    autoRecordRule: options.autoRecordRule,
    reservedAt,
    timingReceipt,
  };
  return options.sessionMode === "tts_only"
    ? {
        ...shared,
        sessionMode: "tts_only" as const,
        suppression: options.suppressionCheck,
      }
    : {
        ...shared,
        sessionMode: "meeting" as const,
        suppression:
          options.suppressionCheck ??
          (options.isAutoRecording
            ? { channelId: options.voiceChannel.id }
            : undefined),
        history: {
          guildId: options.guild.id,
          channelId_timestamp: `${options.voiceChannel.id}#${timestamp}`,
          meetingId,
          channelId: options.voiceChannel.id,
          textChannelId: options.textChannel.id,
          timestamp,
          participants: [],
          duration: 0,
          transcribeMeeting: options.transcribeMeeting,
          generateNotes: options.generateNotes,
          meetingCreatorId: options.creator.id,
          isAutoRecording: options.isAutoRecording ?? false,
          context: options.meetingContext,
          tags: options.tags,
          startReason: options.startReason,
          startTriggeredByUserId: options.startTriggeredByUserId,
          autoRecordRule: options.autoRecordRule,
        },
      };
}
export async function disposeFailedInitialization(
  initialization: MeetingInitialization,
): Promise<boolean> {
  const meeting = initialization.meeting;
  if (!meeting) {
    for (const cleanup of initialization.cleanup) cleanup();
    return true;
  }
  const original = meeting.reservation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 5_000);
  });
  try {
    meeting.finishing = true;
    meeting.finished = true;
    const closeAudio =
      meeting.captureAudio ||
      meeting.recordBotAudio ||
      Boolean(meeting.audioData.ffmpegProcess);
    meeting.captureAudio = false;
    meeting.recordBotAudio = false;
    const processing = stopMeetingProcessing(meeting);
    const output = closeAudio
      ? closeFailedInitializationOutput(meeting)
      : Promise.resolve(true);
    meeting.ttsQueue?.stopAndClear();
    for (const cleanup of initialization.cleanup) cleanup();
    if (meeting.timeoutTimer) clearTimeout(meeting.timeoutTimer);
    deleteMeeting(meeting);
    meeting.setFinished();
    return await Promise.race([
      Promise.all([processing, output]).then(
        ([, closed]) => closed && areMeetingNoticesSettled(meeting, original),
      ),
      expired,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shouldLoadMeetingDictionary(meeting: MeetingData) {
  return meeting.captureAudio;
}
function resolveVoiceFeatures(
  canCaptureAudio: boolean,
  liveVoiceOverride: boolean | undefined,
  liveVoiceCommandsOverride: boolean | undefined,
  chatTtsOverride: boolean | undefined,
) {
  const liveVoiceEnabled =
    canCaptureAudio &&
    config.liveVoice.mode === "tts_gate" &&
    liveVoiceOverride !== false;
  const liveVoiceCommandsEnabled =
    canCaptureAudio &&
    config.liveVoice.mode === "tts_gate" &&
    liveVoiceCommandsOverride === true;
  const chatTtsEnabled = chatTtsOverride ?? false;
  return { liveVoiceEnabled, liveVoiceCommandsEnabled, chatTtsEnabled };
}
/** Whether the session receives audio: only a meeting does, and only when capture is on. */
export function sessionCapturesAudio(
  options: Pick<MeetingInitOptions, "sessionMode" | "captureAudio">,
): boolean {
  const { sessionMode = "meeting", captureAudio = sessionMode === "meeting" } =
    options;
  return captureAudio && sessionMode === "meeting";
}
export type MeetingInitialization = {
  meeting?: MeetingData;
  cleanup: Array<() => void>;
};
export type MeetingSessionHooks = {
  /** Collects what a failed start must undo; `disposeFailedInitialization` undoes it. */
  initialization?: MeetingInitialization;
  /** Aborted when the lease is lost; set before capture can begin. */
  ownershipSignal?: AbortSignal;
  /** Called once the receiver is subscribed, which is where a start ends. */
  onReceiving?(): void;
};

/** Everything a start does after voice is Ready, up to a live meeting in the map. */
export async function buildMeetingSession(
  options: MeetingInitOptions,
  reservation: SessionReservation,
  connection: VoiceConnection,
  signal: AbortSignal,
  hooks: MeetingSessionHooks = {},
): Promise<MeetingData> {
  const initialization = hooks.initialization ?? { cleanup: [] };
  const {
    meetingId,
    sessionMode = "meeting",
    captureAudio = sessionMode === "meeting",
    recordBotAudio = captureAudio,
    storeChatLog = sessionMode === "meeting",
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
    chatTtsSpeakerPrefixMode = DEFAULT_PREFIX_MODE,
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
  const canCaptureAudio = captureAudio && sessionMode === "meeting";

  signal.throwIfAborted();
  const receiver = connection.receiver;
  const attendance: Set<string> = new Set<string>();
  const { liveVoiceEnabled, liveVoiceCommandsEnabled, chatTtsEnabled } =
    resolveVoiceFeatures(
      canCaptureAudio,
      liveVoiceOverride,
      liveVoiceCommandsOverride,
      chatTtsOverride,
    );
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
    reservation,
    ownershipSignal: hooks.ownershipSignal,
    meetingId: meetingId ?? uuidv4(),
    sessionMode,
    captureAudio: canCaptureAudio,
    recordBotAudio,
    storeChatLog,
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
    startTime: new Date(reservation.reservedAt),
    creator,
    liveAudioPlayer,
    liveVoiceEnabled,
    liveVoiceCommandsEnabled,
    liveVoiceTtsVoice,
    chatTtsEnabled,
    chatTtsVoice,
    chatTtsSpeakerPrefixMode,
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
    leaseOwnerInstanceId: reservation.ownerInstanceId,
  };
  initialization.meeting = meeting;
  meeting.runtimeConfig = await resolveMeetingRuntimeConfig({
    guildId: meeting.guildId,
    channelId: meeting.voiceChannel.id,
    userId: meeting.creator.id,
    tier: subscriptionTier,
  });
  signal.throwIfAborted();
  if (meeting.sessionMode === "meeting") freezeCompletionPolicy(meeting);

  if (meeting.sessionMode === "tts_only") {
    meeting.resetTtsOnlyIdleTimer = () => resetTtsOnlyIdleTimeout(meeting);
  }

  if (liveAudioPlayer) {
    meeting.ttsQueue = createTtsQueue(meeting, liveAudioPlayer);
  }

  if (meeting.captureAudio || meeting.recordBotAudio) {
    openOutputFile(meeting);
  }

  // Set up error handling for the connection
  connection.on("error", (error) => {
    if (meeting.finishing || meeting.finished) return;
    console.error("Voice connection error:", error);
    void runMeetingNoticeMutation(
      meeting,
      () =>
        textChannel.send(
          `There was an error trying to join the voice channel${isAutoRecording ? " for auto-recording" : ""}.`,
        ),
      (error) =>
        error instanceof DiscordAPIError &&
        error.status >= 400 &&
        error.status < 500,
    ).catch(() => {
      console.warn("Voice error notification failed:", {
        stage: "connection-error-notification",
        meetingId: meeting.meetingId,
      });
    });
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

  signal.throwIfAborted();
  if (meeting.captureAudio) {
    await Promise.all(
      voiceChannel.members.map((member) =>
        subscribeToUserVoice(meeting, member.user.id),
      ),
    );

    receiver.speaking.on("start", (userId) => {
      userStartTalking(meeting, userId);
    });

    receiver.speaking.on("end", (userId) => {
      userStopTalking(meeting, userId);
    });
  }
  hooks.onReceiving?.();

  if (meeting.storeChatLog || meeting.chatTtsEnabled) {
    const collector = voiceChannel.createMessageCollector();
    initialization.cleanup.push(() => collector.stop());
    collector.on("collect", (message) => {
      if (meeting.finishing || meeting.finished) return;
      if (message.author.bot) return;

      const participant =
        meeting.participants.get(message.author.id) ??
        (message.member
          ? fromMember(message.member)
          : fromUser(message.author));

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

      if (meeting.storeChatLog) {
        meeting.chatLog.push(entry);
        meeting.attendance.add(formatUserMention(message.author.id));
      }

      void maybeSpeakChatMessage(meeting, message, entry).catch((error) => {
        if (!getMeetingProcessingSignal(meeting).aborted)
          console.error("Chat TTS failed", error);
      });
    });
  }

  signal.throwIfAborted();
  // Add meeting to the global map
  addMeeting(meeting);
  if (meeting.sessionMode === "meeting") {
    meetingsStarted.inc();
    captureEvent("meeting_started", {
      userId: resolveMeetingActorId(meeting),
      guildId: meeting.guildId,
      properties: {
        trigger: meeting.startReason,
        surface: "discord",
        is_auto_recording: meeting.isAutoRecording,
      },
    });
  }

  signal.throwIfAborted();
  await applyVoiceSessionNickname(meeting, signal);
  signal.throwIfAborted();
  resetTtsOnlyIdleTimeout(meeting);

  if (shouldLoadMeetingDictionary(meeting)) {
    try {
      meeting.dictionaryEntries = await listDictionaryEntriesService(
        meeting.guildId,
      );
    } catch (error) {
      console.warn("Failed to load dictionary entries:", error);
    }
  }

  signal.throwIfAborted();

  // Set a timer to automatically end the meeting after the specified duration
  if (onTimeout) {
    const durationLimitMs = maxMeetingDurationMs ?? MAXIMUM_MEETING_DURATION;
    const durationPretty =
      maxMeetingDurationPretty ?? MAXIMUM_MEETING_DURATION_PRETTY;
    meeting.timeoutTimer = setTimeout(() => {
      const state: NonNullable<MeetingData["recordingLimitNotice"]> = {};
      meeting.recordingLimitNotice = state;
      meeting.endReason = MEETING_END_REASONS.TIMEOUT;
      onTimeout(meeting);
      state.pending = notifyRecordingLimit(
        {
          guildId: meeting.guildId,
          userId: resolveMeetingActorId(meeting),
          limitType: "meeting_duration",
          limitSurface: "duration_stop",
          outcome: "ended_session",
          limitMinutes: durationLimitMs / 60000,
          message: `Recording stopped at the ${durationPretty} limit for this meeting. Your recording will finish processing as usual.`,
        },
        textChannel,
        state,
      ).catch(() => undefined);
    }, durationLimitMs);
  }

  return meeting;
}
