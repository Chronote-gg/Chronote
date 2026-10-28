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
      mentionableRoles: [],
    };
  }
}

async function currentFormattedContext(
  history: MeetingHistory,
  signal: AbortSignal,
) {
  const depth = config.context.memoryDepth;
  const { availability, data } = await collectMeetingContext(
    {
      guildId: history.guildId,
      voiceChannel: { id: history.channelId },
      meetingContext: history.context,
      dictionaryEntries: await listDictionaryEntriesService(history.guildId),
    },
    isMemoryEnabled(),
    // One extra row, since the meeting being retried is usually the newest.
    { signal, strict: true, memoryDepth: depth + 1 },
  );
  if (availability !== "available")
    throw new Error("Current meeting context unavailable");
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
  const [labels, formattedContext, chatLog] = await Promise.all([
    currentGuildLabels(history),
    currentFormattedContext(history, signal),
    storedChatLog(history, signal),
  ]);
  const participants = new Map(history.participants.map((p) => [p.id, p]));
  const attendance = new Set(
    history.participants.map((p) => formatUserMention(p.id)),
  );
  const notesPrompt = await fetchNotesChatPrompt({
    promptName: config.langfuse.notesPromptName,
    mentionableRoles: labels.mentionableRoles,
    participants: history.participants,
    chatContext: formatChatLogForPrompt({ chatLog }),
    labels: {
      formattedContext,
      botDisplayName: BOT_DISPLAY_NAME,
      serverName: labels.serverName,
      serverDescription: "",
      voiceChannelName: labels.voiceChannelName,
      attendees: resolveMeetingAttendees({ participants, attendance }).join(
        ", ",
      ),
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
    signal,
    notesPrompt,
  };
}
