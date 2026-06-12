import type { Message } from "discord.js";
import { config } from "./services/configService";
import type { MeetingData } from "./types/meeting-data";
import type { ChatEntry } from "./types/chat";
import { fetchUserSpeechSettings } from "./services/userSpeechSettingsService";
import {
  chatTtsDropped,
  chatTtsEnqueued,
  chatTtsMonthlyLimitBlocked,
} from "./metrics";
import { resolveTtsVoice } from "./utils/ttsVoices";
import { formatParticipantLabel } from "./utils/participants";
import {
  getGuildLimits,
  getLimitsForTier,
} from "./services/subscriptionService";
import {
  buildChatTtsMonthlyLimitTextOnly,
  releaseChatTtsMessageUsageReservation,
  reserveChatTtsMessageUsage,
  type ChatTtsUsageReservation,
} from "./services/chatTtsUsageService";
import {
  buildTtsSpeechText,
  resolveChatTtsSpeakerPrefixMode,
} from "./utils/ttsText";

async function resolveUserSettings(meeting: MeetingData, userId: string) {
  if (!meeting.chatTtsUserSettings) {
    meeting.chatTtsUserSettings = new Map();
  }
  if (meeting.chatTtsUserSettings.has(userId)) {
    return meeting.chatTtsUserSettings.get(userId) ?? undefined;
  }
  const settings = await fetchUserSpeechSettings(meeting.guildId, userId);
  meeting.chatTtsUserSettings.set(userId, settings ?? null);
  return settings;
}

async function sendMonthlyLimitNotice(
  meeting: MeetingData,
  status: ChatTtsUsageReservation,
  options: { finalAcceptedMessage?: boolean } = {},
) {
  if (meeting.chatTtsMonthlyLimitNoticeSent) return;
  meeting.chatTtsMonthlyLimitNoticeSent = true;
  await Promise.resolve(
    meeting.textChannel.send(buildChatTtsMonthlyLimitTextOnly(status, options)),
  ).catch((error) => {
    console.warn("Failed to send chat TTS monthly limit notice.", error);
  });
}

export async function maybeSpeakChatMessage(
  meeting: MeetingData,
  message: Message,
  entry: ChatEntry,
): Promise<void> {
  if (!meeting.chatTtsEnabled) return;
  if (!meeting.ttsQueue) return;
  if (!meeting.voiceChannel.members.has(message.author.id)) return;

  const trimmed = message.content.trim();
  if (!trimmed) return;

  const settings = await resolveUserSettings(meeting, message.author.id);
  if (settings?.chatTtsDisabled) return;

  const maxChars = config.chatTts.maxChars;
  const text =
    maxChars > 0 && trimmed.length > maxChars
      ? trimmed.slice(0, maxChars)
      : trimmed;

  const meetingDefault = meeting.chatTtsVoice ?? config.chatTts.defaultVoice;
  const voice = resolveTtsVoice(settings?.chatTtsVoice, meetingDefault);
  const prefixMode = resolveChatTtsSpeakerPrefixMode(
    settings?.chatTtsSpeakerPrefixMode,
    meeting.chatTtsSpeakerPrefixMode,
  );
  const speakerName =
    settings?.chatTtsSpokenName ??
    formatParticipantLabel(entry.user, {
      includeUsername: false,
      fallbackName: message.author.username,
    });
  const speechText = buildTtsSpeechText({
    message: text,
    speakerName,
    prefixMode,
    context: "chat",
  });

  const limits = meeting.subscriptionTier
    ? getLimitsForTier(meeting.subscriptionTier)
    : (await getGuildLimits(meeting.guildId)).limits;
  const usageReservation = await reserveChatTtsMessageUsage({
    guildId: meeting.guildId,
    limit: limits.maxChatTtsMessagesMonthly,
  });
  if (!usageReservation.allowed) {
    chatTtsDropped.inc();
    chatTtsMonthlyLimitBlocked.inc();
    await sendMonthlyLimitNotice(meeting, usageReservation);
    return;
  }

  const enqueued = meeting.ttsQueue.enqueue({
    text: speechText,
    voice,
    userId: message.author.id,
    source: "chat_tts",
    messageId: message.id,
    volumePercent: settings?.chatTtsVolumePercent,
  });

  if (!enqueued) {
    if (usageReservation.reserved) {
      await releaseChatTtsMessageUsageReservation({
        guildId: usageReservation.guildId,
        period: usageReservation.period,
      });
    }
    chatTtsDropped.inc();
    console.warn(
      `Chat TTS queue full, dropping message ${message.id} from ${message.author.id}`,
    );
    return;
  }

  chatTtsEnqueued.inc();
  entry.source = "chat_tts";
  if (
    usageReservation.limit !== undefined &&
    usageReservation.remaining === 0
  ) {
    await sendMonthlyLimitNotice(meeting, usageReservation, {
      finalAcceptedMessage: true,
    });
  }
}
