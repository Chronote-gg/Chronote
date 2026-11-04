import type { MeetingRuntimeConfig } from "../config/types";
import { TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE } from "../constants";
import type { ChatEntry } from "../types/chat";
import type { MeetingHistory } from "../types/db";
import type { MeetingNotesInput } from "../types/meeting-data";
import { formatUserMention } from "../utils/participants";
import { resolveMeetingAttendees } from "../utils/meetingAttendees";
import { config } from "./configService";
import {
  collectMeetingContext,
  formatContextForPrompt,
  isMemoryEnabled,
} from "./contextService";
import { listDictionaryEntriesService } from "./dictionaryService";
import { resolveMeetingRuntimeConfig } from "./meetingConfigService";
import {
  listBotGuildsCached,
  listGuildChannelsCached,
  listGuildRolesCached,
} from "./discordCacheService";
import {
  fetchNotesChatPrompt,
  formatChatLogForPrompt,
  isMentionableRole,
} from "./notesPromptService";
import { fetchJsonFromS3 } from "./storageService";
import {
  cleanupContentTranscription,
  resolveCleanupModel,
  retainCleanupTranscript,
} from "./transcriptionCleanupService";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { resolveGuildSubscription } from "./subscriptionService";

const PLACEHOLDER_SERVER_NAME = "Discord server";
const PLACEHOLDER_CHANNEL_NAME = "Voice channel";
const BOT_DISPLAY_NAME = "Chronote";

/** Names are prompt labels only, so a Discord outage degrades them rather than failing the retry. */
async function currentGuildLabels(history: MeetingHistory) {
  try {
    const [guilds, channels, roles] = await Promise.all([
      listBotGuildsCached(),
      listGuildChannelsCached(history.guildId),
      listGuildRolesCached(history.guildId),
    ]);
    return {
      serverName:
        guilds.find((guild) => guild.id === history.guildId)?.name ??
        PLACEHOLDER_SERVER_NAME,
      voiceChannelName:
        channels.find((channel) => channel.id === history.channelId)?.name ??
        PLACEHOLDER_CHANNEL_NAME,
      channelNames: channels.map((channel) => channel.name).join(", "),
      roleNames: roles.map((role) => role.name).join(", "),
      mentionableRoles: roles.filter((role) =>
        isMentionableRole(role, history.guildId),
      ),
    };
  } catch (error) {
    console.warn("Discord guild context unavailable for processing retry", {
      guildId: history.guildId,
      error,
    });
    return {
      serverName: PLACEHOLDER_SERVER_NAME,
      voiceChannelName: PLACEHOLDER_CHANNEL_NAME,
      channelNames: "",
      roleNames: "",
      mentionableRoles: [],
    };
  }
}

/** The server and channel scoped settings a meeting started now would get. */
async function currentRuntimeConfig(
  history: MeetingHistory,
  creatorId: string,
): Promise<MeetingRuntimeConfig> {
  const { tier } = await resolveGuildSubscription(history.guildId);
  return resolveMeetingRuntimeConfig({
    guildId: history.guildId,
    channelId: history.channelId,
    userId: creatorId,
    tier,
  });
}

async function currentContextData(
  history: MeetingHistory,
  runtimeConfig: MeetingRuntimeConfig,
  signal: AbortSignal,
  includeMemory: boolean,
) {
  const { availability, data } = await collectMeetingContext(
    {
      guildId: history.guildId,
      voiceChannel: { id: history.channelId },
      meetingContext: history.context,
      dictionaryEntries: await listDictionaryEntriesService(history.guildId),
      runtimeConfig,
    },
    includeMemory,
    // One extra row, since the meeting being retried is usually the newest.
    { signal, strict: true, memoryDepth: config.context.memoryDepth + 1 },
  );
  if (availability !== "available")
    throw new Error("Current meeting context unavailable");
  return data;
}

async function currentFormattedContext(
  history: MeetingHistory,
  runtimeConfig: MeetingRuntimeConfig,
  signal: AbortSignal,
) {
  const depth = config.context.memoryDepth;
  const data = await currentContextData(
    history,
    runtimeConfig,
    signal,
    isMemoryEnabled(),
  );
  // ponytail: meetings recorded after this one push earlier ones out of the
  // fetched window, so an old meeting can get less memory than it had live.
  const recentMeetings = data.recentMeetings
    ?.filter((meeting) => meeting.timestamp < history.timestamp)
    .slice(0, depth);
  return formatContextForPrompt(
    {
      ...data,
      recentMeetings: recentMeetings?.length ? recentMeetings : undefined,
    },
    "notes",
  );
}

function storedAttendance(history: MeetingHistory) {
  return {
    participants: new Map(history.participants.map((p) => [p.id, p])),
    attendance: new Set(
      history.participants.map((p) => formatUserMention(p.id)),
    ),
  };
}

function attendeeLabels(history: MeetingHistory): string {
  return resolveMeetingAttendees(storedAttendance(history)).join(", ");
}

async function storedChatLog(history: MeetingHistory, signal: AbortSignal) {
  if (!history.chatS3Key) return [];
  return (await fetchJsonFromS3<ChatEntry[]>(history.chatS3Key, signal)) ?? [];
}

/**
 * Notes input for a meeting whose frozen generation settings are unusable,
 * assembled from the server's current settings and the stored row.
 */
export async function buildCurrentNotesInput(
  history: MeetingHistory,
  transcript: string,
  signal: AbortSignal,
): Promise<MeetingNotesInput> {
  if (!history.meetingCreatorId)
    throw new Error("Meeting has no creator to attribute generation to");
  const runtimeConfig = await currentRuntimeConfig(
    history,
    history.meetingCreatorId,
  );
  const [labels, formattedContext, chatLog] = await Promise.all([
    currentGuildLabels(history),
    currentFormattedContext(history, runtimeConfig, signal),
    storedChatLog(history, signal),
  ]);
  const { participants, attendance } = storedAttendance(history);
  const notesPrompt = await fetchNotesChatPrompt({
    promptName: config.langfuse.notesPromptName,
    mentionableRoles: labels.mentionableRoles,
    participants: history.participants,
    chatContext: formatChatLogForPrompt({ chatLog, runtimeConfig }),
    labels: {
      formattedContext,
      botDisplayName: BOT_DISPLAY_NAME,
      serverName: labels.serverName,
      serverDescription: "",
      voiceChannelName: labels.voiceChannelName,
      attendees: attendeeLabels(history),
      events: "",
      channelNames: labels.channelNames,
      longStoryTargetChars: config.notes.longStoryTargetChars,
      transcript,
    },
  });
  return {
    meetingId: history.meetingId,
    guildId: history.guildId,
    channelId: history.channelId,
    generateNotes: history.generateNotes,
    transcribeMeeting: history.transcribeMeeting,
    startTime: new Date(history.timestamp),
    finalTranscript: transcript,
    meetingName: history.meetingName,
    tags: history.tags,
    participants,
    attendance,
    creator: { id: history.meetingCreatorId },
    guild: { id: history.guildId, name: labels.serverName, description: "" },
    voiceChannel: { id: history.channelId, name: labels.voiceChannelName },
    runtimeConfig: {
      modelChoices: runtimeConfig.modelChoices,
      modelParams: runtimeConfig.modelParams,
      dictionary: runtimeConfig.dictionary,
      visionCaptions: runtimeConfig.visionCaptions,
    },
    signal,
    notesPrompt,
  };
}

async function cleanupTranscript(
  history: MeetingHistory,
  creatorId: string,
  runtimeConfig: MeetingRuntimeConfig,
  transcription: string,
  signal: AbortSignal,
): Promise<string> {
  const [labels, contextData] = await Promise.all([
    currentGuildLabels(history),
    currentContextData(history, runtimeConfig, signal, false),
  ]);
  const prompt = await getLangfuseChatPrompt({
    name: config.langfuse.transcriptionCleanupPromptName,
    variables: {
      formattedContext: formatContextForPrompt(contextData, "transcription"),
      attendees: attendeeLabels(history),
      serverName: labels.serverName,
      serverDescription: "",
      voiceChannelName: labels.voiceChannelName,
      roles: labels.roleNames,
      events: "",
      channelNames: labels.channelNames,
      transcription,
    },
  });
  return cleanupContentTranscription(
    {
      meetingId: history.meetingId,
      creator: { id: creatorId },
      guild: { id: history.guildId },
      voiceChannel: { id: history.channelId },
      signal,
    },
    prompt,
    resolveCleanupModel(runtimeConfig),
  );
}

/**
 * Cleans a transcript the way a live meeting in this channel would now. Like
 * the live path, a cleanup failure keeps the original text.
 */
export async function cleanupWithCurrentSettings(
  history: MeetingHistory,
  transcription: string,
  signal: AbortSignal,
): Promise<string> {
  const creatorId = history.meetingCreatorId;
  if (!creatorId || !transcription.trim()) return transcription;
  try {
    const runtimeConfig = await currentRuntimeConfig(history, creatorId);
    const premium = runtimeConfig.premiumTranscription;
    if (!premium.enabled || !premium.cleanupEnabled) return transcription;
    const cleaned = await cleanupTranscript(
      history,
      creatorId,
      runtimeConfig,
      transcription,
      signal,
    );
    signal.throwIfAborted();
    return retainCleanupTranscript(
      transcription,
      cleaned,
      TRANSCRIPTION_CLEANUP_LINES_DIFFERENCE_ISSUE,
    );
  } catch (error) {
    signal.throwIfAborted();
    console.warn("Processing retry transcript cleanup failed", {
      meetingId: history.meetingId,
      error,
    });
    return transcription;
  }
}
