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
import { chatTtsDropped, chatTtsEnqueued } from "../metrics";
import { buildUpgradePrompt } from "../utils/upgradePrompt";
import { getGuildLimits } from "../services/subscriptionService";
import {
  formatParticipantLabel,
  formatUserMention,
  fromMember,
} from "../utils/participants";
import { resolveTtsVoice } from "../utils/ttsVoices";
import type { MeetingData } from "../types/meeting-data";
import type { ChatEntry } from "../types/chat";
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
  payload: {
    text: string;
    voice: string;
    userId: string;
    messageId: string;
  },
): Promise<boolean> {
  const enqueued = queue.enqueue({
    text: payload.text,
    voice: payload.voice,
    userId: payload.userId,
    source: "chat_tts",
    messageId: payload.messageId,
  });

  if (!enqueued) {
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

export async function handleSayCommand(
  interaction: ChatInputCommandInteraction,
) {
  const guildId = await requireGuild(interaction);
  if (!guildId) return;

  const limitsResult = await requireTier(interaction, guildId);
  if (!limitsResult) return;

  const member = await resolveMember(interaction);
  if (!member) {
    await interaction.reply({
      content: "Could not resolve your membership in this server.",
      ephemeral: true,
    });
    return;
  }

  const message = await requireSayMessage(interaction);
  if (!message) return;

  const session = await resolveSaySession({
    interaction,
    guildId,
    member,
    limitsResult,
  });
  if (!session) return;
  const { meeting, startedTtsOnly } = session;

  const queue = await requireQueue(interaction, meeting);
  if (!queue) return;

  const settings = await resolveUserSettings(meeting, interaction.user.id);
  const meetingDefault = meeting.chatTtsVoice ?? config.chatTts.defaultVoice;
  const voice = resolveTtsVoice(settings?.chatTtsVoice, meetingDefault);
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
  const speechText = buildTtsSpeechText({
    message: message.text,
    speakerName,
    prefixMode,
    context: "say",
  });

  const enqueued = await enqueueOrReply(interaction, queue, {
    text: speechText,
    voice,
    userId: interaction.user.id,
    messageId: interaction.id,
  });
  if (!enqueued) return;

  meeting.participants.set(participant.id, participant);
  meeting.attendance.add(formatUserMention(participant.id));

  if (meeting.storeChatLog !== false) {
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

  await interaction.reply({
    content: startedTtsOnly
      ? "Started a TTS-only voice session with no recording or transcription, and queued your message."
      : "Queued your message to be spoken.",
    ephemeral: true,
  });
}
