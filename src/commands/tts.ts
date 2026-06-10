import {
  ChannelType,
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  TextChannel,
  User,
  VoiceBasedChannel,
} from "discord.js";
import { endTtsOnlySession, getMeeting } from "../meetings";
import {
  buildUserSpeechSettingsRecord,
  fetchUserSpeechSettings,
  setUserSpeechSettings,
} from "../services/userSpeechSettingsService";
import { TTS_VOICES, normalizeTtsVoice } from "../utils/ttsVoices";
import type { MeetingData } from "../types/meeting-data";
import {
  formatParticipantLabel,
  fromMember,
  fromUser,
} from "../utils/participants";
import { normalizeUserChatTtsSpeakerPrefixMode } from "../utils/ttsText";
import {
  DEFAULT_TTS_VOLUME_PERCENT,
  MAX_TTS_VOLUME_PERCENT,
  MIN_TTS_VOLUME_PERCENT,
  normalizeTtsVolumePercent,
} from "../utils/ttsVolume";
import { setChannelContext } from "../services/channelContextService";
import { getGuildLimits } from "../services/subscriptionService";
import { buildUpgradePrompt } from "../utils/upgradePrompt";
import { checkBotPermissions } from "../utils/permissions";

const MAX_VOICE_LENGTH = 32;
const MAX_SPOKEN_NAME_LENGTH = 64;

type TtsSubcommandHandler = (
  interaction: ChatInputCommandInteraction,
  guildId: string,
) => Promise<void>;

type UserSettingsUpdate = {
  chatTtsDisabled?: boolean;
  chatTtsVoice?: string | null;
  chatTtsSpokenName?: string | null;
  chatTtsSpeakerPrefixMode?: "never" | "chat_only" | "always" | null;
  chatTtsVolumePercent?: number | null;
};

const applyMeetingUserSettingsCache = (options: {
  meeting: MeetingData | undefined;
  guildId: string;
  userId: string;
  updatedBy: string;
  update: UserSettingsUpdate;
}) => {
  const { meeting, guildId, userId, updatedBy, update } = options;
  if (!meeting || meeting.finished) return;
  if (!meeting.chatTtsUserSettings) {
    meeting.chatTtsUserSettings = new Map();
  }
  const existing = meeting.chatTtsUserSettings.get(userId) ?? null;
  const nextSettings = buildUserSpeechSettingsRecord({
    guildId,
    userId,
    updatedBy,
    existing,
    update,
  });
  if (!nextSettings) {
    meeting.chatTtsUserSettings.delete(userId);
    return;
  }

  meeting.chatTtsUserSettings.set(userId, nextSettings);
};

const saveUserSettings = async (
  interaction: ChatInputCommandInteraction,
  guildId: string,
  update: UserSettingsUpdate,
) => {
  await setUserSpeechSettings(
    guildId,
    interaction.user.id,
    interaction.user.id,
    update,
  );
  applyMeetingUserSettingsCache({
    meeting: getMeeting(guildId),
    guildId,
    userId: interaction.user.id,
    updatedBy: interaction.user.id,
    update,
  });
};

async function fetchGuildMember(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<GuildMember | null> {
  return (
    interaction.guild?.members.cache.get(userId) ??
    (await interaction.guild?.members.fetch(userId).catch(() => null)) ??
    null
  );
}

async function requireManageChannels(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  const member = await fetchGuildMember(interaction, interaction.user.id);
  if (member?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return true;
  }
  await interaction.reply({
    content: "You need Manage Channels to configure channel TTS automation.",
    ephemeral: true,
  });
  return false;
}

async function requireTtsTier(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<boolean> {
  const { limits } = await getGuildLimits(guildId);
  if (limits.liveVoiceEnabled) return true;
  await interaction.reply(
    buildUpgradePrompt(
      "Chat-to-speech is available on the Basic plan. Upgrade to enable channel TTS automation.",
    ),
  );
  return false;
}

function resolveVoiceChannelOption(
  interaction: ChatInputCommandInteraction,
): VoiceBasedChannel | null {
  const channel = interaction.options.getChannel("voice-channel", true);
  if (channel.type !== ChannelType.GuildVoice) return null;
  return channel as VoiceBasedChannel;
}

function resolveTextChannelOption(
  interaction: ChatInputCommandInteraction,
): TextChannel | null {
  const channel = interaction.options.getChannel("text-channel", true);
  if (channel.type !== ChannelType.GuildText) return null;
  return channel as TextChannel;
}

const handleDisable: TtsSubcommandHandler = async (interaction, guildId) => {
  await saveUserSettings(interaction, guildId, { chatTtsDisabled: true });
  await interaction.reply({
    content: "Your chat messages will no longer be spoken aloud here.",
    ephemeral: true,
  });
};

const handleEnable: TtsSubcommandHandler = async (interaction, guildId) => {
  await saveUserSettings(interaction, guildId, { chatTtsDisabled: false });
  await interaction.reply({
    content: "Your chat messages can be spoken aloud again.",
    ephemeral: true,
  });
};

const handleVoice: TtsSubcommandHandler = async (interaction, guildId) => {
  const rawVoice = interaction.options.getString("voice", true).trim();
  if (!rawVoice) {
    await interaction.reply({
      content: "Please provide a voice name.",
      ephemeral: true,
    });
    return;
  }
  if (rawVoice.length > MAX_VOICE_LENGTH) {
    await interaction.reply({
      content: "Voice name is too long.",
      ephemeral: true,
    });
    return;
  }

  const normalized = rawVoice.toLowerCase();
  if (normalized !== "default" && !normalizeTtsVoice(normalized)) {
    await interaction.reply({
      content:
        `Unsupported voice. Choose one of: ${TTS_VOICES.join(", ")}, ` +
        'or use "default" to reset.',
      ephemeral: true,
    });
    return;
  }

  const voiceValue =
    normalized === "default" ? null : (normalizeTtsVoice(normalized) ?? null);
  await saveUserSettings(interaction, guildId, { chatTtsVoice: voiceValue });
  await interaction.reply({
    content: voiceValue
      ? `Saved your chat-to-speech voice as "${voiceValue}".`
      : "Reset your chat-to-speech voice to the server default.",
    ephemeral: true,
  });
};

const handlePrefix: TtsSubcommandHandler = async (interaction, guildId) => {
  const rawMode = interaction.options.getString("mode", true);
  const normalized = normalizeUserChatTtsSpeakerPrefixMode(rawMode);
  if (!normalized) {
    await interaction.reply({
      content: "Unknown speaker prefix mode.",
      ephemeral: true,
    });
    return;
  }

  const modeValue = normalized === "default" ? null : normalized;
  await saveUserSettings(interaction, guildId, {
    chatTtsSpeakerPrefixMode: modeValue,
  });
  await interaction.reply({
    content:
      modeValue === null
        ? "Reset your TTS speaker prefix preference to the server default."
        : `Saved your TTS speaker prefix preference as "${modeValue}".`,
    ephemeral: true,
  });
};

const handleNickname: TtsSubcommandHandler = async (interaction, guildId) => {
  const spokenName = interaction.options.getString("name", true).trim();
  if (!spokenName) {
    await interaction.reply({
      content: "Please provide a spoken name.",
      ephemeral: true,
    });
    return;
  }
  if (spokenName.length > MAX_SPOKEN_NAME_LENGTH) {
    await interaction.reply({
      content: `Spoken name is too long (max ${MAX_SPOKEN_NAME_LENGTH} characters).`,
      ephemeral: true,
    });
    return;
  }

  await saveUserSettings(interaction, guildId, {
    chatTtsSpokenName: spokenName,
  });
  await interaction.reply({
    content: `Saved your spoken TTS name as "${spokenName}".`,
    ephemeral: true,
  });
};

const handleClearNickname: TtsSubcommandHandler = async (
  interaction,
  guildId,
) => {
  await saveUserSettings(interaction, guildId, {
    chatTtsSpokenName: null,
  });
  await interaction.reply({
    content: "Reset your spoken TTS name to your Discord display name.",
    ephemeral: true,
  });
};

const handleVolume: TtsSubcommandHandler = async (interaction, guildId) => {
  const rawPercent = interaction.options.getInteger("percent", true);
  const percent = normalizeTtsVolumePercent(rawPercent);
  if (percent === undefined) {
    await interaction.reply({
      content: `Choose a TTS volume from ${MIN_TTS_VOLUME_PERCENT}% to ${MAX_TTS_VOLUME_PERCENT}%.`,
      ephemeral: true,
    });
    return;
  }

  const volumeValue = percent === DEFAULT_TTS_VOLUME_PERCENT ? null : percent;
  await saveUserSettings(interaction, guildId, {
    chatTtsVolumePercent: volumeValue,
  });
  await interaction.reply({
    content:
      volumeValue === null
        ? `Reset your TTS volume to ${DEFAULT_TTS_VOLUME_PERCENT}%.`
        : `Saved your TTS volume as ${volumeValue}%.`,
    ephemeral: true,
  });
};

const handleEnableChannel: TtsSubcommandHandler = async (
  interaction,
  guildId,
) => {
  if (!(await requireManageChannels(interaction))) return;
  if (!(await requireTtsTier(interaction, guildId))) return;

  const voiceChannel = resolveVoiceChannelOption(interaction);
  const textChannel = resolveTextChannelOption(interaction);
  if (!voiceChannel || !textChannel) {
    await interaction.reply({
      content: "Choose one voice channel and one text channel.",
      ephemeral: true,
    });
    return;
  }

  const botMember = await fetchGuildMember(
    interaction,
    interaction.client.user.id,
  );
  if (!botMember) {
    await interaction.reply({
      content: "Bot not found in this server.",
      ephemeral: true,
    });
    return;
  }

  const permissionCheck = checkBotPermissions(
    voiceChannel,
    textChannel,
    botMember,
  );
  if (!permissionCheck.success) {
    await interaction.reply({
      content: `I can't enable channel TTS yet. ${permissionCheck.errorMessage}`,
      ephemeral: true,
    });
    return;
  }

  await setChannelContext(guildId, voiceChannel.id, interaction.user.id, {
    chatTtsEnabled: true,
    chatTtsTtsOnlyEnabled: true,
    defaultNotesChannelId: textChannel.id,
  });
  await interaction.reply({
    content: `Automatic chat-to-speech enabled for **${voiceChannel.name}**. Status messages will use **#${textChannel.name}**.`,
    ephemeral: true,
  });
};

const handleDisableChannel: TtsSubcommandHandler = async (
  interaction,
  guildId,
) => {
  if (!(await requireManageChannels(interaction))) return;
  const voiceChannel = resolveVoiceChannelOption(interaction);
  if (!voiceChannel) {
    await interaction.reply({
      content: "Choose a voice channel.",
      ephemeral: true,
    });
    return;
  }

  await setChannelContext(guildId, voiceChannel.id, interaction.user.id, {
    chatTtsEnabled: false,
  });
  await interaction.reply({
    content: `Automatic chat-to-speech disabled for **${voiceChannel.name}**.`,
    ephemeral: true,
  });
};

const handleStop: TtsSubcommandHandler = async (interaction, guildId) => {
  const meeting = getMeeting(guildId);
  if (!meeting || meeting.finished) {
    await interaction.reply({
      content: "No active meeting or TTS-only session to stop.",
      ephemeral: true,
    });
    return;
  }
  const member = await fetchGuildMember(interaction, interaction.user.id);
  const isCreator = meeting.creator.id === interaction.user.id;
  const canManage =
    member?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false;
  if (!isCreator && !canManage) {
    await interaction.reply({
      content:
        "You need to be the meeting creator or have Manage Channels to stop audio.",
      ephemeral: true,
    });
    return;
  }
  if (meeting.sessionMode === "tts_only") {
    await endTtsOnlySession(meeting);
    await interaction.reply({
      content: "Stopped the TTS-only session.",
      ephemeral: true,
    });
    return;
  }
  meeting.ttsQueue?.stopAndClear();
  await interaction.reply({
    content: "Stopped current playback and cleared the queue.",
    ephemeral: true,
  });
};

const subcommandHandlers: Record<string, TtsSubcommandHandler> = {
  disable: handleDisable,
  enable: handleEnable,
  voice: handleVoice,
  prefix: handlePrefix,
  nickname: handleNickname,
  "clear-nickname": handleClearNickname,
  volume: handleVolume,
  "enable-channel": handleEnableChannel,
  "disable-channel": handleDisableChannel,
  stop: handleStop,
};

async function resolveWhoisTarget(
  interaction: ChatInputCommandInteraction,
): Promise<User> {
  return interaction.options.getUser("user") ?? interaction.user;
}

async function resolveWhoisMember(
  interaction: ChatInputCommandInteraction,
  target: User,
): Promise<GuildMember | null> {
  return (
    interaction.guild?.members.cache.get(target.id) ??
    (await interaction.guild?.members.fetch(target.id).catch(() => null)) ??
    null
  );
}

const buildWhoisLines = (options: {
  discordName: string;
  settings: Awaited<ReturnType<typeof fetchUserSpeechSettings>>;
}) => {
  const { discordName, settings } = options;
  return [
    `Discord name: ${discordName}`,
    `Spoken TTS name: ${settings?.chatTtsSpokenName ?? discordName}`,
    `TTS voice: ${settings?.chatTtsVoice ?? "server default"}`,
    `Speaker prefix: ${settings?.chatTtsSpeakerPrefixMode ?? "server default"}`,
    `TTS volume: ${settings?.chatTtsVolumePercent ?? DEFAULT_TTS_VOLUME_PERCENT}%`,
    `Automatic chat TTS opt-out: ${settings?.chatTtsDisabled ? "yes" : "no"}`,
  ];
};

export async function handleWhoisCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const target = await resolveWhoisTarget(interaction);
  const member = await resolveWhoisMember(interaction, target);
  const settings = await fetchUserSpeechSettings(
    interaction.guildId,
    target.id,
  );
  const participant = member ? fromMember(member) : fromUser(target);
  const discordName = formatParticipantLabel(participant, {
    includeUsername: true,
    fallbackName: target.username,
  });

  await interaction.reply({
    content: buildWhoisLines({ discordName, settings }).join("\n"),
    ephemeral: true,
  });
}

export async function handleTtsCommand(
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const handler = subcommandHandlers[interaction.options.getSubcommand()];
  if (!handler) {
    await interaction.reply({
      content: "Unknown /tts command.",
      ephemeral: true,
    });
    return;
  }

  await handler(interaction, interaction.guildId);
}
