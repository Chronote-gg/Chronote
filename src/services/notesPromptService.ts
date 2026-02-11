import type { ChatAttachment, ChatEntry } from "../types/chat";
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
const IMAGE_CAPTIONS_SUFFIX_HEADER =
  "\n\nShared images (AI captions, OCR-lite):\n";
const MAX_IMAGE_CAPTION_CHARS_IN_PROMPT_LINE = 300;
const MAX_IMAGE_VISIBLE_TEXT_CHARS_IN_PROMPT_LINE = 400;

type ImageCaptionPromptLineOptions = {
  speaker: string;
  timestampIso: string;
  attachmentName: string;
  caption: string;
  visibleText: string;
};

type EntryImageCaptionsForPromptOptions = {
  entry: ChatEntry;
  maxChars: number;
};

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

const formatTimestampForPrompt = (timestampIso: string): string => {
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return timestampIso;
  return date.toISOString();
};

const resolveAttachmentCaptionText = (
  attachment: ChatAttachment,
): { caption: string; visibleText: string } | null => {
  const caption = attachment.aiCaption?.trim() ?? "";
  const visibleText = attachment.aiVisibleText?.trim() ?? "";
  if (!caption && !visibleText) return null;

  return {
    caption: caption
      ? truncateText(caption, MAX_IMAGE_CAPTION_CHARS_IN_PROMPT_LINE)
      : "",
    visibleText: visibleText
      ? truncateText(visibleText, MAX_IMAGE_VISIBLE_TEXT_CHARS_IN_PROMPT_LINE)
      : "",
  };
};

const formatImageCaptionPromptLine = (
  options: ImageCaptionPromptLineOptions,
): string => {
  const prefix = `- [${options.speaker} @ ${options.timestampIso}] ${options.attachmentName}: `;
  const withCaption = prefix + (options.caption || "(no caption)");
  if (!options.visibleText) return withCaption;
  return `${withCaption} | visible text: ${options.visibleText}`;
};

const formatEntryImageCaptionsForPrompt = (
  options: EntryImageCaptionsForPromptOptions,
): string[] => {
  const { entry } = options;
  if (options.maxChars <= 0) return [];
  if (entry.type !== "message") return [];
  if (!entry.attachments || entry.attachments.length === 0) return [];

  const speaker = formatParticipantLabel(entry.user, {
    includeUsername: true,
  });
  const timestampIso = formatTimestampForPrompt(entry.timestamp);

  const lines: string[] = [];
  let remaining = options.maxChars;

  for (const attachment of entry.attachments) {
    if (remaining <= 0) break;
    const captionText = resolveAttachmentCaptionText(attachment);
    if (!captionText) continue;

    const attachmentName = attachment.name?.trim() || "image";
    const fullLine = formatImageCaptionPromptLine({
      speaker,
      timestampIso,
      attachmentName,
      caption: captionText.caption,
      visibleText: captionText.visibleText,
    });

    const line = truncateText(fullLine, Math.max(0, remaining - 1));
    if (!line.trim()) break;
    lines.push(line);
    remaining -= line.length + 1;
  }

  return lines;
};

const formatImageCaptionLinesForPrompt = (
  chatLog: ChatEntry[],
  maxChars: number,
): string | undefined => {
  if (!chatLog || chatLog.length === 0) return undefined;
  if (maxChars <= 0) return undefined;

  const lines: string[] = [];
  let remaining = maxChars;

  for (let i = chatLog.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const entry = chatLog[i];
    const entryLines = formatEntryImageCaptionsForPrompt({
      entry,
      maxChars: remaining,
    });
    if (entryLines.length === 0) continue;
    const joined = entryLines.join("\n");
    if (!joined.trim()) continue;

    if (lines.length === 0) {
      lines.push(joined);
      remaining -= joined.length;
      continue;
    }

    const withLeadingNewline = `\n${joined}`;
    if (withLeadingNewline.length > remaining) break;
    lines.push(joined);
    remaining -= withLeadingNewline.length;
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
};

const formatImageCaptionsSuffixForPrompt = (
  chatLog: ChatEntry[],
  maxChars: number,
): string => {
  if (maxChars <= 0) return "";
  if (!chatLog || chatLog.length === 0) return "";

  const lineBudget = maxChars - IMAGE_CAPTIONS_SUFFIX_HEADER.length;
  if (lineBudget <= 0) return "";
  const lines = formatImageCaptionLinesForPrompt(chatLog, lineBudget);
  if (!lines) return "";

  const suffix = IMAGE_CAPTIONS_SUFFIX_HEADER + lines;
  return truncateText(suffix, maxChars);
};

const truncateChatToFit = (chat: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (chat.length <= maxChars) return chat;

  const header = "...(recent chat truncated)...\n";
  if (maxChars <= header.length) {
    return truncateText(header, maxChars);
  }

  const sliceLength = maxChars - header.length;
  const tail = chat.slice(chat.length - sliceLength);
  return header + tail;
};

const formatChatLogForPrompt = (
  meeting: MeetingData,
  maxLength: number = MAX_CHAT_LOG_PROMPT_LENGTH,
): string | undefined => {
  const chatLog = meeting.chatLog;
  if (!chatLog || chatLog.length === 0) {
    return undefined;
  }

  const visionConfig = meeting.runtimeConfig?.visionCaptions;
  const imageCaptionBudget = visionConfig?.enabled
    ? clampInt(
        visionConfig.maxTotalChars,
        DEFAULT_IMAGE_CAPTION_MAX_CHARS,
        0,
        maxLength,
      )
    : 0;
  const captionsSuffix = formatImageCaptionsSuffixForPrompt(
    chatLog,
    imageCaptionBudget,
  );
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

  const chatBlock = truncateChatToFit(combinedLines, remainingLength);
  return chatBlock + captionsSuffix;
};

const formatParticipantRoster = (meeting: MeetingData): string | undefined => {
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
};

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
        ? "Use the chat context below, participant messages plus AI image caption notes, to honor explicit include or omit requests."
        : "No additional participant chat was captured; rely on transcript and provided context.",
      chatContextBlock: chatContext
        ? `Chat context (recent, chronological participant chat with AI image caption notes):\n${chatContext}`
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
