import {
  ChannelType,
  ChatInputCommandInteraction,
  GuildMember,
  TextChannel,
} from "discord.js";
import { NoSubscriberBehavior, createAudioPlayer } from "@discordjs/voice";
import { getMeeting, initializeMeeting } from "../meetings";
import { createTtsQueue } from "../ttsQueue";
import { config } from "../services/configService";
import { fetchUserSpeechSettings } from "../services/userSpeechSettingsService";
import {
  chatTtsDropped,
  chatTtsEnqueued,
  chatTtsMonthlyLimitBlocked,
} from "../metrics";
import { buildUpgradePrompt } from "../utils/upgradePrompt";
import { getGuildLimits } from "../services/subscriptionService";
import {
  buildChatTtsMonthlyLimitMessage,
  releaseChatTtsMessageUsageReservation,
  reserveChatTtsMessageUsage,
  type ChatTtsUsageReservation,
} from "../services/chatTtsUsageService";
import {
  formatParticipantLabel,
  formatUserMention,
  fromMember,
} from "../utils/participants";
import { resolveTtsVoice } from "../utils/ttsVoices";
import type { MeetingData } from "../types/meeting-data";
import type { ChatEntry } from "../types/chat";
import type { Participant } from "../types/participants";
import { checkBotPermissions } from "../utils/permissions";
import { resolveMeetingVoiceSettings } from "../services/meetingVoiceSettingsService";
import {
  buildTtsSpeechText,
  resolveChatTtsSpeakerPrefixMode,
} from "../utils/ttsText";

async function resolveMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  return (
    guild.members.cache.get(interaction.user.id) ??
    (await guild.members.fetch(interaction.user.id).catch(() => null))
  );
}

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

function ensureTtsQueue(meeting: MeetingData) {
  if (meeting.ttsQueue) return meeting.ttsQueue;
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });
  meeting.connection.subscribe(player);
  meeting.liveAudioPlayer = player;
  meeting.ttsQueue = createTtsQueue(meeting, player);
  return meeting.ttsQueue;
}

type SayMessage = {
  text: string;
};

type GuildLimitsResult = Awaited<ReturnType<typeof getGuildLimits>>;

type SaySession = {
  meeting: MeetingData;
  startedTtsOnly: boolean;
};

type SayInitialContext = {
  guildId: string;
  limitsResult: GuildLimitsResult;
  member: GuildMember;
  message: SayMessage;
};

type SayPlaybackPayload = {
  participant: Participant;
  text: string;
  voice: string;
  volumePercent?: number;
};

async function requireGuild(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return null;
  }
  return interaction.guildId;
}

async function requireTier(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<GuildLimitsResult | null> {
  const result = await getGuildLimits(guildId);
  const { limits } = result;
  if (!limits.liveVoiceEnabled) {
    await interaction.reply(
      buildUpgradePrompt(
        "Chat-to-speech is available on the Basic plan. Upgrade to use /say.",
      ),
    );
    return null;
  }
  return result;
}

async function requireMemberInMeeting(
  interaction: ChatInputCommandInteraction,
  meeting: MeetingData,
): Promise<GuildMember | null> {
  const member = await resolveMember(interaction);
  if (!member) {
    await interaction.reply({
      content: "Could not resolve your membership in this server.",
      ephemeral: true,
    });
    return null;
  }
  if (member.voice.channelId !== meeting.voiceChannel.id) {
    await interaction.reply({
      content: "Join the meeting voice channel to use /say.",
      ephemeral: true,
    });
    return null;
  }
  return member;
}

async function requireTextChannel(
  interaction: ChatInputCommandInteraction,
): Promise<TextChannel | null> {
  if (
    !interaction.channel ||
    interaction.channel.type !== ChannelType.GuildText
  ) {
    await interaction.reply({
      content:
        "Use /say from a server text channel so I know where to post status.",
      ephemeral: true,
    });
    return null;
  }
  return interaction.channel;
}

async function startTtsOnlySession(options: {
  interaction: ChatInputCommandInteraction;
  guildId: string;
  member: GuildMember;
  limitsResult: GuildLimitsResult;
}): Promise<SaySession | null> {
  const { interaction, guildId, member, limitsResult } = options;
  const textChannel = await requireTextChannel(interaction);
  if (!textChannel) return null;

  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: "Join a voice channel to use /say.",
      ephemeral: true,
    });
    return null;
  }

  const botMember = interaction.guild!.members.cache.get(
    interaction.client.user!.id,
  );
  if (!botMember) {
    await interaction.reply({
      content: "Bot not found in this server.",
      ephemeral: true,
    });
    return null;
  }

  const permissionCheck = checkBotPermissions(
    voiceChannel,
    textChannel,
    botMember,
  );
  if (!permissionCheck.success) {
    await interaction.reply({
      content: `I can't start a TTS-only session yet. ${permissionCheck.errorMessage}`,
      ephemeral: true,
    });
    return null;
  }

  const voiceSettings = await resolveMeetingVoiceSettings(
    guildId,
    voiceChannel.id,
    limitsResult.limits,
  );
  if (!voiceSettings.chatTtsTtsOnlyEnabled) {
    await interaction.reply({
      content: "TTS-only sessions are disabled for this channel or server.",
      ephemeral: true,
    });
    return null;
  }

  const meeting = await initializeMeeting({
    sessionMode: "tts_only",
    captureAudio: false,
    recordBotAudio: false,
    storeChatLog: false,
    voiceChannel,
    textChannel,
    guild: interaction.guild!,
    creator: interaction.user,
    transcribeMeeting: false,
    generateNotes: false,
    chatTtsEnabled: false,
    chatTtsVoice: voiceSettings.chatTtsVoice,
    chatTtsSpeakerPrefixMode: voiceSettings.chatTtsSpeakerPrefixMode,
    subscriptionTier: limitsResult.subscription.tier,
  });

  return { meeting, startedTtsOnly: true };
}

async function resolveSaySession(options: {
  interaction: ChatInputCommandInteraction;
  guildId: string;
  member: GuildMember;
  limitsResult: GuildLimitsResult;
}): Promise<SaySession | null> {
  const existing = getMeeting(options.guildId);
  if (existing && !existing.finished) {
    const memberInMeeting = await requireMemberInMeeting(
      options.interaction,
      existing,
    );
    if (!memberInMeeting) return null;
    return { meeting: existing, startedTtsOnly: false };
  }

  return startTtsOnlySession(options);
}

async function requireSayMessage(
  interaction: ChatInputCommandInteraction,
): Promise<SayMessage | null> {
  const rawText = interaction.options.getString("message", true).trim();
  if (!rawText) {
    await interaction.reply({
      content: "Please enter a message to speak aloud.",
      ephemeral: true,
    });
    return null;
  }
  const maxChars = config.chatTts.maxChars;
  if (maxChars > 0 && rawText.length > maxChars) {
    await interaction.reply({
      content: `Message too long (max ${maxChars} characters). Please shorten it.`,
      ephemeral: true,
    });
    return null;
  }
  return { text: rawText };
}

async function requireQueue(
  interaction: ChatInputCommandInteraction,
  meeting: MeetingData,
): Promise<ReturnType<typeof ensureTtsQueue> | null> {
  try {
    return ensureTtsQueue(meeting);
  } catch (error) {
    console.error("Failed to initialize TTS queue for /say:", error);
    await interaction.reply({
      content: "Unable to start playback right now. Please try again.",
      ephemeral: true,
    });
    return null;
  }
}

async function enqueueOrReply(
  interaction: ChatInputCommandInteraction,
  queue: ReturnType<typeof ensureTtsQueue>,
  usageReservation: ChatTtsUsageReservation,
  payload: {
    text: string;
    voice: string;
    userId: string;
    messageId: string;
    volumePercent?: number;
  },
): Promise<boolean> {
  const enqueued = queue.enqueue({
    text: payload.text,
    voice: payload.voice,
    userId: payload.userId,
    source: "chat_tts",
    messageId: payload.messageId,
    volumePercent: payload.volumePercent,
  });

  if (!enqueued) {
    await releaseMonthlyUsageReservationIfNeeded(usageReservation);
    chatTtsDropped.inc();
    await interaction.reply({
      content: "The speech queue is full right now. Try again in a moment.",
      ephemeral: true,
    });
    return false;
  }

  chatTtsEnqueued.inc();
  return true;
}

async function replyWithMonthlyLimit(
  interaction: ChatInputCommandInteraction,
  status: Parameters<typeof buildChatTtsMonthlyLimitMessage>[0],
  options: Parameters<typeof buildChatTtsMonthlyLimitMessage>[1] = {},
) {
  chatTtsMonthlyLimitBlocked.inc();
  await interaction.reply(
    buildUpgradePrompt(buildChatTtsMonthlyLimitMessage(status, options)),
  );
}

async function resolveSayInitialContext(
  interaction: ChatInputCommandInteraction,
): Promise<SayInitialContext | null> {
  const guildId = await requireGuild(interaction);
  if (!guildId) return null;

  const limitsResult = await requireTier(interaction, guildId);
  if (!limitsResult) return null;

  const member = await resolveMember(interaction);
  if (!member) {
    await interaction.reply({
      content: "Could not resolve your membership in this server.",
      ephemeral: true,
    });
    return null;
  }

  const message = await requireSayMessage(interaction);
  if (!message) return null;

  return { guildId, limitsResult, member, message };
}

async function reserveMonthlyUsageOrReply(options: {
  interaction: ChatInputCommandInteraction;
  guildId: string;
  limit?: number;
  compedTier?: "basic" | "pro" | null;
}): Promise<ChatTtsUsageReservation | null> {
  const { interaction, guildId, limit, compedTier } = options;
  const usageReservation = await reserveChatTtsMessageUsage({ guildId, limit });
  if (!usageReservation.allowed) {
    await replyWithMonthlyLimit(interaction, usageReservation, { compedTier });
    return null;
  }
  return usageReservation;
}

async function releaseMonthlyUsageReservationIfNeeded(
  usageReservation: ChatTtsUsageReservation,
) {
  if (!usageReservation.reserved) return;
  await releaseChatTtsMessageUsageReservation({
    guildId: usageReservation.guildId,
    period: usageReservation.period,
  });
}

async function buildSayPlaybackPayload(options: {
  interaction: ChatInputCommandInteraction;
  meeting: MeetingData;
  member: GuildMember;
  message: SayMessage;
}): Promise<SayPlaybackPayload> {
  const { interaction, meeting, member, message } = options;
  const settings = await resolveUserSettings(meeting, interaction.user.id);
  const meetingDefault = meeting.chatTtsVoice ?? config.chatTts.defaultVoice;
  const participant =
    meeting.participants.get(interaction.user.id) ?? fromMember(member);
  const speakerName =
    settings?.chatTtsSpokenName ??
    formatParticipantLabel(participant, {
      includeUsername: false,
      fallbackName: interaction.user.username,
    });
  const prefixMode = resolveChatTtsSpeakerPrefixMode(
    settings?.chatTtsSpeakerPrefixMode,
    meeting.chatTtsSpeakerPrefixMode,
  );

  return {
    participant,
    text: buildTtsSpeechText({
      message: message.text,
      speakerName,
      prefixMode,
      context: "say",
    }),
    voice: resolveTtsVoice(settings?.chatTtsVoice, meetingDefault),
    volumePercent: settings?.chatTtsVolumePercent,
  };
}

function recordSayChatEntry(options: {
  interaction: ChatInputCommandInteraction;
  meeting: MeetingData;
  message: SayMessage;
  participant: Participant;
}) {
  const { interaction, meeting, message, participant } = options;
  meeting.participants.set(participant.id, participant);
  meeting.attendance.add(formatUserMention(participant.id));

  if (meeting.storeChatLog === false) return;
  const entry: ChatEntry = {
    type: "message",
    source: "chat_tts",
    user: participant,
    channelId: interaction.channelId,
    content: message.text,
    messageId: interaction.id,
    timestamp: new Date(interaction.createdTimestamp).toISOString(),
  };
  meeting.chatLog.push(entry);
}

async function replyWithFinalMonthlyLimitIfNeeded(
  interaction: ChatInputCommandInteraction,
  usageReservation: ChatTtsUsageReservation,
  compedTier?: "basic" | "pro" | null,
): Promise<boolean> {
  if (
    usageReservation.limit === undefined ||
    usageReservation.remaining !== 0
  ) {
    return false;
  }
  await interaction.reply(
    buildUpgradePrompt(
      buildChatTtsMonthlyLimitMessage(usageReservation, {
        finalAcceptedMessage: true,
        compedTier,
      }),
    ),
  );
  return true;
}

async function acknowledgeSayQueued(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  await interaction.deleteReply();
}

export async function handleSayCommand(
  interaction: ChatInputCommandInteraction,
) {
  const initial = await resolveSayInitialContext(interaction);
  if (!initial) return;
  const { guildId, limitsResult, member, message } = initial;
  const limit = limitsResult.limits.maxChatTtsMessagesMonthly;
  const compedTier =
    limitsResult.subscription.billingSource === "manual_comp"
      ? limitsResult.subscription.grantTier
      : null;

  const usageReservation = await reserveMonthlyUsageOrReply({
    interaction,
    guildId,
    limit,
    compedTier,
  });
  if (!usageReservation) return;

  const session = await resolveSaySession({
    interaction,
    guildId,
    member,
    limitsResult,
  });
  if (!session) {
    await releaseMonthlyUsageReservationIfNeeded(usageReservation);
    return;
  }
  const { meeting } = session;

  const queue = await requireQueue(interaction, meeting);
  if (!queue) {
    await releaseMonthlyUsageReservationIfNeeded(usageReservation);
    return;
  }

  const payload = await buildSayPlaybackPayload({
    interaction,
    meeting,
    member,
    message,
  });

  const enqueued = await enqueueOrReply(interaction, queue, usageReservation, {
    text: payload.text,
    voice: payload.voice,
    userId: interaction.user.id,
    messageId: interaction.id,
    volumePercent: payload.volumePercent,
  });
  if (!enqueued) return;

  recordSayChatEntry({
    interaction,
    meeting,
    message,
    participant: payload.participant,
  });
  if (
    await replyWithFinalMonthlyLimitIfNeeded(
      interaction,
      usageReservation,
      compedTier,
    )
  ) {
    return;
  }
  await acknowledgeSayQueued(interaction);
}
