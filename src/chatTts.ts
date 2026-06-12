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
  options: Parameters<typeof buildChatTtsMonthlyLimitTextOnly>[1] = {},
) {
  if (meeting.chatTtsMonthlyLimitNoticeSent) return;
  meeting.chatTtsMonthlyLimitNoticeSent = true;
  await Promise.resolve(
    meeting.textChannel.send(buildChatTtsMonthlyLimitTextOnly(status, options)),
  ).catch((error) => {
    console.warn("Failed to send chat TTS monthly limit notice.", error);
  });
}

type ChatTtsPlayback = {
  queue: NonNullable<MeetingData["ttsQueue"]>;
  text: string;
  voice: string;
  volumePercent?: number;
};

async function resolveChatTtsPlayback(
  meeting: MeetingData,
  message: Message,
  entry: ChatEntry,
): Promise<ChatTtsPlayback | null> {
  if (!meeting.chatTtsEnabled) return null;
  if (!meeting.ttsQueue) return null;
  if (!meeting.voiceChannel.members.has(message.author.id)) return null;

  const trimmed = message.content.trim();
  if (!trimmed) return null;

  const settings = await resolveUserSettings(meeting, message.author.id);
  if (settings?.chatTtsDisabled) return null;

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

  return {
    queue: meeting.ttsQueue,
    text: buildTtsSpeechText({
      message: text,
      speakerName,
      prefixMode,
      context: "chat",
    }),
    voice,
    volumePercent: settings?.chatTtsVolumePercent,
  };
}

async function resolveMonthlyMessageLimit(meeting: MeetingData) {
  const resolved = await getGuildLimits(meeting.guildId);
  const limits = meeting.subscriptionTier
    ? getLimitsForTier(meeting.subscriptionTier)
    : resolved.limits;
  return {
    limit: limits.maxChatTtsMessagesMonthly,
    compedTier:
      resolved.subscription.billingSource === "manual_comp"
        ? resolved.subscription.grantTier
        : null,
  };
}

async function releaseReservationIfNeeded(
  usageReservation: ChatTtsUsageReservation,
) {
  if (!usageReservation.reserved) return;
  await releaseChatTtsMessageUsageReservation({
    guildId: usageReservation.guildId,
    period: usageReservation.period,
  });
}

async function sendFinalMonthlyLimitNoticeIfNeeded(
  meeting: MeetingData,
  usageReservation: ChatTtsUsageReservation,
  compedTier?: "basic" | "pro" | null,
) {
  if (
    usageReservation.limit === undefined ||
    usageReservation.remaining !== 0
  ) {
    return;
  }
  await sendMonthlyLimitNotice(meeting, usageReservation, {
    finalAcceptedMessage: true,
    compedTier,
  });
}

export async function maybeSpeakChatMessage(
  meeting: MeetingData,
  message: Message,
  entry: ChatEntry,
): Promise<void> {
  const playback = await resolveChatTtsPlayback(meeting, message, entry);
  if (!playback) return;

  const monthlyLimit = await resolveMonthlyMessageLimit(meeting);
  const usageReservation = await reserveChatTtsMessageUsage({
    guildId: meeting.guildId,
    limit: monthlyLimit.limit,
  });
  if (!usageReservation.allowed) {
    chatTtsDropped.inc();
    chatTtsMonthlyLimitBlocked.inc();
    await sendMonthlyLimitNotice(meeting, usageReservation, {
      compedTier: monthlyLimit.compedTier,
    });
    return;
  }

  const enqueued = playback.queue.enqueue({
    text: playback.text,
    voice: playback.voice,
    userId: message.author.id,
    source: "chat_tts",
    messageId: message.id,
    volumePercent: playback.volumePercent,
  });

  if (!enqueued) {
    await releaseReservationIfNeeded(usageReservation);
    chatTtsDropped.inc();
    console.warn(
      `Chat TTS queue full, dropping message ${message.id} from ${message.author.id}`,
    );
    return;
  }

  chatTtsEnqueued.inc();
  entry.source = "chat_tts";
  await sendFinalMonthlyLimitNoticeIfNeeded(
    meeting,
    usageReservation,
    monthlyLimit.compedTier,
  );
}
