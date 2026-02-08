import type { ChatEntry } from "../types/chat";
import type { MeetingData } from "../types/meeting-data";
import { renderChatEntryLine } from "../utils/chatLog";
import { formatParticipantLabel } from "../utils/participants";
import {
  buildMeetingContext,
  formatContextForPrompt,
  isMemoryEnabled,
} from "./contextService";
import { config } from "./configService";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { resolveMeetingAttendees } from "../utils/meetingAttendees";

const MAX_CHAT_LOG_PROMPT_LENGTH = 20000;

function formatChatLogForPrompt(
  chatLog: ChatEntry[],
  maxLength: number = MAX_CHAT_LOG_PROMPT_LENGTH,
): string | undefined {
  if (!chatLog || chatLog.length === 0) {
    return undefined;
  }

  // Drop obvious noise so participant instructions stay visible
  const filtered = chatLog.filter((entry) => entry.type === "message");

  const relevant = filtered.length > 0 ? filtered : chatLog;
  const combinedLines = relevant.map((e) => renderChatEntryLine(e)).join("\n");
  if (!combinedLines) {
    return undefined;
  }

  if (combinedLines.length > maxLength) {
    const trimmed = combinedLines.slice(combinedLines.length - maxLength);
    return "...(recent chat truncated)...\n" + trimmed;
  }

  return combinedLines;
}

function formatParticipantRoster(meeting: MeetingData): string | undefined {
  const participants = Array.from(meeting.participants.values());
  if (participants.length === 0) {
    return undefined;
  }
  return participants
    .map((participant) => {
      const preferred = formatParticipantLabel(participant, {
        includeUsername: false,
        fallbackName: participant.username,
      });
      const username = participant.username || participant.tag || "unknown";
      const displayName = participant.displayName ?? "-";
      const serverNickname = participant.serverNickname ?? "-";
      const profile = `https://discord.com/users/${participant.id}`;
      const mention = `<@${participant.id}>`;
      return `- ${preferred} | username: ${username} | display name: ${displayName} | server nickname: ${serverNickname} | id: ${participant.id} | mention: ${mention} | profile: ${profile}`;
    })
    .join("\n");
}

export async function getNotesPrompt(meeting: MeetingData) {
  const contextData = await buildMeetingContext(meeting, isMemoryEnabled());
  const formattedContext = formatContextForPrompt(contextData, "notes");

  const serverName = meeting.guild.name;
  const serverDescription = meeting.guild.description ?? "";
  const roles = meeting.guild.roles
    .valueOf()
    .map((role) => role.name)
    .join(", ");
  const events = meeting.guild.scheduledEvents
    .valueOf()
    .map((event) => event.name)
    .join(", ");
  const channelNames = meeting.guild.channels
    .valueOf()
    .map((channel) => channel.name)
    .join(", ");

  const botDisplayName =
    meeting.guild.members.me?.displayName ||
    meeting.guild.members.me?.nickname ||
    meeting.guild.members.me?.user.username ||
    "Meeting Notes Bot";

  const chatContext = formatChatLogForPrompt(meeting.chatLog);
  const participantRoster = formatParticipantRoster(meeting);

  const longStoryTestMode = config.notes.longStoryTestMode;
  const contextTestMode = config.context.testMode;
  const promptName = longStoryTestMode
    ? config.langfuse.notesLongStoryPromptName
    : contextTestMode
      ? config.langfuse.notesContextTestPromptName
      : config.langfuse.notesPromptName;

  return await getLangfuseChatPrompt({
    name: promptName,
    variables: {
      formattedContext,
      botDisplayName,
      chatContextInstruction: chatContext
        ? "Use the raw chat provided below to honor any explicit include or omit requests."
        : "No additional participant chat was captured; rely on transcript and provided context.",
      chatContextBlock: chatContext
        ? `Participant chat (recent, raw, chronological):\n${chatContext}`
        : "",
      participantRoster: participantRoster ?? "No participant roster captured.",
      serverName,
      serverDescription,
      voiceChannelName: meeting.voiceChannel.name,
      attendees: resolveMeetingAttendees(meeting).join(", "),
      roles,
      events,
      channelNames,
      longStoryTargetChars: config.notes.longStoryTargetChars,
      transcript: meeting.finalTranscript ?? "",
    },
  });
}
