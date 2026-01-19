import { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { NoSubscriberBehavior, createAudioPlayer } from "@discordjs/voice";
import { getMeeting } from "../meetings";
import { createTtsQueue } from "../ttsQueue";
import { config } from "../services/configService";
import { fetchUserSpeechSettings } from "../services/userSpeechSettingsService";
import { chatTtsDropped, chatTtsEnqueued } from "../metrics";
import { buildUpgradePrompt } from "../utils/upgradePrompt";
import { getGuildLimits } from "../services/subscriptionService";
import { formatUserMention, fromMember } from "../utils/participants";
import { resolveTtsVoice } from "../utils/ttsVoices";
import type { MeetingData } from "../types/meeting-data";
import type { ChatEntry } from "../types/chat";

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

async function requireMeeting(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<MeetingData | null> {
  const meeting = getMeeting(guildId);
  if (!meeting || meeting.finished) {
    await interaction.reply({
      content: "There is no active meeting to speak in right now.",
      ephemeral: true,
    });
    return null;
  }
  return meeting;
}

async function requireTier(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<boolean> {
  const { limits } = await getGuildLimits(guildId);
  if (!limits.liveVoiceEnabled) {
    await interaction.reply(
      buildUpgradePrompt(
        "Chat-to-speech is available on the Basic plan. Upgrade to use /say.",
      ),
    );
    return false;
  }
  return true;
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

  const meeting = await requireMeeting(interaction, guildId);
  if (!meeting) return;

  const tierOk = await requireTier(interaction, guildId);
  if (!tierOk) return;

  const member = await requireMemberInMeeting(interaction, meeting);
  if (!member) return;

  const message = await requireSayMessage(interaction);
  if (!message) return;

  const queue = await requireQueue(interaction, meeting);
  if (!queue) return;

  const settings = await resolveUserSettings(meeting, interaction.user.id);
  const meetingDefault = meeting.chatTtsVoice ?? config.chatTts.defaultVoice;
  const voice = resolveTtsVoice(settings?.chatTtsVoice, meetingDefault);

  const enqueued = await enqueueOrReply(interaction, queue, {
    text: message.text,
    voice,
    userId: interaction.user.id,
    messageId: interaction.id,
  });
  if (!enqueued) return;

  const participant =
    meeting.participants.get(interaction.user.id) ?? fromMember(member);
  meeting.participants.set(participant.id, participant);
  meeting.attendance.add(formatUserMention(participant.id));

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

  await interaction.reply({
    content: "Queued your message to be spoken.",
    ephemeral: true,
  });
}
