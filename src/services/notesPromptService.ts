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
const DEFAULT_IMAGE_CAPTION_MAX_CHARS = 3000;

const clampInt = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Math.floor(typeof value === "number" ? value : Number(value));
  const resolved = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, resolved));
};

const truncateText = (value: string, maxChars: number) => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars).trimEnd();
};

function formatImageCaptionsForPrompt(
  chatLog: ChatEntry[],
  maxChars: number,
): string | undefined {
  if (!chatLog || chatLog.length === 0) return undefined;
  if (maxChars <= 0) return undefined;

  const lines: string[] = [];
  let remaining = maxChars;

  for (let i = chatLog.length - 1; i >= 0; i -= 1) {
    if (remaining <= 0) break;
    const entry = chatLog[i];
    if (entry.type !== "message") continue;
    if (!entry.attachments || entry.attachments.length === 0) continue;

    const speaker = formatParticipantLabel(entry.user, {
      includeUsername: true,
    });
    const time = new Date(entry.timestamp).toLocaleString();

    for (const attachment of entry.attachments) {
      if (remaining <= 0) break;
      const caption = attachment.aiCaption?.trim() ?? "";
      const visibleText = attachment.aiVisibleText?.trim() ?? "";
      if (!caption && !visibleText) continue;

      const name = attachment.name?.trim() || "image";
      const basePrefix = `- [${speaker} @ ${time}] ${name}: `;
      const textPrefix = visibleText ? " | visible text: " : "";

      const combinedVisible = visibleText ? truncateText(visibleText, 400) : "";
      const combinedCaption = caption ? truncateText(caption, 300) : "";
      const fullLine =
        basePrefix +
        (combinedCaption || "(no caption)") +
        (combinedVisible ? `${textPrefix}${combinedVisible}` : "");

      const line = truncateText(fullLine, Math.max(0, remaining - 1));
      if (!line.trim()) {
        remaining = 0;
        break;
      }
      lines.push(line);
      remaining -= line.length + 1;
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatChatLogForPrompt(
  meeting: MeetingData,
  maxLength: number = MAX_CHAT_LOG_PROMPT_LENGTH,
): string | undefined {
  const chatLog = meeting.chatLog;
  if (!chatLog || chatLog.length === 0) {
    return undefined;
  }

  const imageCaptionBudget = clampInt(
    meeting.runtimeConfig?.visionCaptions?.maxTotalChars,
    DEFAULT_IMAGE_CAPTION_MAX_CHARS,
    0,
    maxLength,
  );
  const imageCaptions = formatImageCaptionsForPrompt(
    chatLog,
    imageCaptionBudget,
  );
  const captionsSuffix = imageCaptions
    ? `\n\nShared images (AI captions, OCR-lite):\n${imageCaptions}`
    : "";
  if (captionsSuffix.length >= maxLength) {
    return truncateText(captionsSuffix, maxLength);
  }
  const remainingLength = Math.max(0, maxLength - captionsSuffix.length);

  // Drop obvious noise so participant instructions stay visible
  const filtered = chatLog.filter((entry) => entry.type === "message");

  const relevant = filtered.length > 0 ? filtered : chatLog;
  const combinedLines = relevant.map((e) => renderChatEntryLine(e)).join("\n");
  if (!combinedLines) {
    return undefined;
  }

  if (combinedLines.length > remainingLength) {
    const header = "...(recent chat truncated)...\n";
    const sliceLength = Math.max(0, remainingLength - header.length);
    const trimmed = combinedLines.slice(combinedLines.length - sliceLength);
    return header + trimmed + captionsSuffix;
  }

  return combinedLines + captionsSuffix;
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

  const chatContext = formatChatLogForPrompt(meeting);
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
