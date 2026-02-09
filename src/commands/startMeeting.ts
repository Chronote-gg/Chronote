import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  CommandInteraction,
  EmbedBuilder,
  GuildMember,
  PermissionsBitField,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";
import {
  deleteMeeting,
  getMeeting,
  hasMeeting,
  initializeMeeting,
} from "../meetings";
import { GuildChannel } from "discord.js/typings";
import { checkBotPermissions } from "../utils/permissions";
import { handleEndMeetingOther } from "./endMeeting";
import { saveMeetingStartToDatabase } from "./saveMeetingHistory";
import { parseTags } from "../utils/tags";
import { getGuildLimits } from "../services/subscriptionService";
import { buildUpgradePrompt } from "../utils/upgradePrompt";
import { resolveMeetingVoiceSettings } from "../services/meetingVoiceSettingsService";
import { config } from "../services/configService";
import {
  getNextAvailableAt,
  getRollingUsageForGuild,
  getRollingWindowMs,
} from "../services/meetingUsageService";
import {
  MEETING_START_REASONS,
  type AutoRecordRule,
  type MeetingStartReason,
} from "../types/meetingLifecycle";

type GuildLimits = Awaited<ReturnType<typeof getGuildLimits>>["limits"];

const buildLiveMeetingUrl = (guildId: string, meetingId: string) => {
  const base = config.frontend.siteUrl?.replace(/\/$/, "");
  if (!base) {
    console.warn(
      `Cannot build live meeting URL for guild ${guildId} and meeting ${meetingId}: config.frontend.siteUrl is not configured.`,
    );
    return null;
  }
  return `${base}/live/${guildId}/${meetingId}`;
};

const buildLimitReachedMessage = (nextAvailableAtIso?: string | null) => {
  const nextLabel = nextAvailableAtIso
    ? `Try again after <t:${Math.floor(
        Date.parse(nextAvailableAtIso) / 1000,
      )}:R>.`
    : "Try again later.";
  return `Weekly meeting minutes limit reached for this plan. ${nextLabel}`;
};

async function getLimitNotice(
  guildId: string,
  limits: GuildLimits,
): Promise<string | null> {
  if (!limits.maxMeetingMinutesRolling) return null;
  const usage = await getRollingUsageForGuild(guildId);
  const limitSeconds = limits.maxMeetingMinutesRolling * 60;
  if (usage.usedSeconds < limitSeconds) return null;
  const windowStartMs = Date.parse(usage.windowStartIso);
  const nextAvailableAtIso = getNextAvailableAt(
    usage.meetings,
    windowStartMs,
    getRollingWindowMs(),
    limitSeconds,
  );
  return buildLimitReachedMessage(nextAvailableAtIso);
}

const getMeetingRequestOptions = (interaction: CommandInteraction) => {
  if (!interaction.isChatInputCommand()) {
    return { meetingContext: undefined, tags: undefined };
  }
  const meetingContext = interaction.options.getString("context") || undefined;
  const rawTags = interaction.options.getString("tags") || undefined;
  return {
    meetingContext,
    tags: rawTags ? parseTags(rawTags) : undefined,
  };
};

type GuildChannelResult =
  | {
      ok: true;
      guild: NonNullable<CommandInteraction["guild"]>;
      guildChannel: GuildChannel;
      textChannel: TextChannel;
    }
  | { ok: false; error: string };

const resolveGuildChannels = (
  interaction: CommandInteraction,
): GuildChannelResult => {
  const channel = interaction.channel;
  const guild = interaction.guild;
  if (!channel || !guild) {
    return { ok: false, error: "Unable to find the channel or guild." };
  }
  if (channel.isDMBased()) {
    return { ok: false, error: "Bot cannot be used within DMs." };
  }
  return {
    ok: true,
    guild,
    guildChannel: channel as GuildChannel,
    textChannel: channel as TextChannel,
  };
};

const resolveBotMember = (guild: NonNullable<CommandInteraction["guild"]>) => {
  const botId = guild.client.user?.id;
  if (!botId) return null;
  return guild.members.cache.get(botId) ?? null;
};

const ensureBotCanSend = (
  guildChannel: GuildChannel,
  botMember: GuildMember,
) => {
  const permissions = guildChannel.permissionsFor(botMember);
  if (!permissions) {
    return "I do not have permission to send messages in this channel.";
  }
  if (!permissions.has(PermissionsBitField.Flags.SendMessages)) {
    return "I do not have permission to send messages in this channel.";
  }
  if (!permissions.has(PermissionsBitField.Flags.ViewChannel)) {
    return "I do not have permission to send messages in this channel.";
  }
  return null;
};

const ensureNoActiveMeeting = (guildId: string) => {
  if (!hasMeeting(guildId)) return null;
  const meeting = getMeeting(guildId);
  if (!meeting) return null;
  if (meeting.finished) {
    deleteMeeting(guildId);
    return null;
  }
  return "A meeting is already active in this server.";
};

type VoiceChannelResult =
  | { ok: true; voiceChannel: VoiceBasedChannel }
  | { ok: false; error: string };

const resolveMemberVoiceChannel = (member: GuildMember): VoiceChannelResult => {
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    return { ok: false, error: "You need to join a voice channel first!" };
  }
  return { ok: true, voiceChannel };
};

export async function handleRequestStartMeeting(
  interaction: CommandInteraction,
) {
  const guildId = interaction.guildId!;
  const { meetingContext, tags } = getMeetingRequestOptions(interaction);
  const channelResult = resolveGuildChannels(interaction);
  if (!channelResult.ok) {
    await interaction.reply(channelResult.error);
    return;
  }

  const { guild, guildChannel, textChannel } = channelResult;
  const botMember = resolveBotMember(guild);
  if (!botMember) {
    await interaction.reply("Bot not found in guild.");
    return;
  }

  const permissionError = ensureBotCanSend(guildChannel, botMember);
  if (permissionError) {
    await interaction.reply(permissionError);
    return;
  }

  const meetingConflict = ensureNoActiveMeeting(guildId);
  if (meetingConflict) {
    await interaction.reply(meetingConflict);
    return;
  }

  const untypedMember = interaction.member;
  if (!untypedMember || !interaction.guild) return;
  const member = untypedMember as GuildMember;
  const voiceResult = resolveMemberVoiceChannel(member);
  if (!voiceResult.ok) {
    await interaction.reply(voiceResult.error);
    return;
  }
  const { voiceChannel } = voiceResult;

  // Tier and limits
  const { limits, subscription } = await getGuildLimits(guildId);
  const limitNotice = await getLimitNotice(guildId, limits);
  if (limitNotice) {
    await interaction.reply(buildUpgradePrompt(limitNotice));
    return;
  }

  // Check bot permissions
  const permissionCheck = checkBotPermissions(
    voiceChannel,
    textChannel,
    botMember,
  );

  if (!permissionCheck.success) {
    await interaction.reply(permissionCheck.errorMessage!);
    return;
  }

  const {
    liveVoiceEnabled,
    liveVoiceCommandsEnabled,
    chatTtsEnabled,
    chatTtsVoice,
    liveVoiceTtsVoice,
  } = await resolveMeetingVoiceSettings(guildId, voiceChannel.id, limits);

  // Initialize the meeting using the core function
  const meeting = await initializeMeeting({
    voiceChannel,
    textChannel,
    guild,
    creator: interaction.user,
    transcribeMeeting: true,
    generateNotes: true,
    meetingContext,
    initialInteraction: undefined,
    isAutoRecording: false,
    startReason: MEETING_START_REASONS.MANUAL_COMMAND,
    startTriggeredByUserId: interaction.user.id,
    tags,
    onTimeout: (meeting) => handleEndMeetingOther(interaction.client, meeting),
    onEndMeeting: (meeting) =>
      handleEndMeetingOther(interaction.client, meeting),
    liveVoiceEnabled,
    liveVoiceCommandsEnabled,
    liveVoiceTtsVoice,
    chatTtsEnabled,
    chatTtsVoice,
    maxMeetingDurationMs: limits.maxMeetingDurationMs,
    maxMeetingDurationPretty: limits.maxMeetingDurationPretty,
    subscriptionTier: subscription.tier,
  });
  void saveMeetingStartToDatabase(meeting);

  const embed = new EmbedBuilder()
    .setTitle("Meeting Started")
    .setDescription(`The meeting has started in **${voiceChannel.name}**.`)
    .addFields({
      name: "Start Time",
      value: `<t:${Math.floor(meeting.startTime.getTime() / 1000)}:F>`,
    })
    .addFields({
      name: "Tip",
      value:
        'Right click the bot in voice and choose "Disconnect" to end the meeting.',
    })
    .setColor(0x00ae86)
    .setTimestamp();

  if (meetingContext) {
    embed.addFields({
      name: "Meeting Context",
      value: meetingContext,
    });
  }

  const endButton = new ButtonBuilder()
    .setCustomId("end_meeting")
    .setLabel("End Meeting")
    .setStyle(ButtonStyle.Danger);

  const editTagsButton = new ButtonBuilder()
    .setCustomId("edit_tags")
    .setLabel("Edit Tags")
    .setStyle(ButtonStyle.Secondary);

  const liveMeetingUrl = buildLiveMeetingUrl(
    meeting.guildId,
    meeting.meetingId,
  );
  const liveMeetingButton = liveMeetingUrl
    ? new ButtonBuilder()
        .setLabel("Live transcript")
        .setStyle(ButtonStyle.Link)
        .setURL(liveMeetingUrl)
    : null;
  const components = [endButton, editTagsButton];
  if (liveMeetingButton) {
    components.push(liveMeetingButton);
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...components,
  );

  const reply = await interaction.reply({
    embeds: [embed],
    components: [row],
    fetchReply: true,
  });
  meeting.startMessageId = reply.id;
}

export async function handleAutoStartMeeting(
  client: Client,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextChannel,
  options?: {
    tags?: string[];
    liveVoiceEnabled?: boolean;
    liveVoiceCommandsEnabled?: boolean;
    liveVoiceTtsVoice?: string;
    chatTtsEnabled?: boolean;
    chatTtsVoice?: string;
    startReason?: MeetingStartReason;
    startTriggeredByUserId?: string;
    autoRecordRule?: AutoRecordRule;
  },
) {
  const guildId = voiceChannel.guild.id;
  const { limits, subscription } = await getGuildLimits(guildId);
  const limitNotice = await getLimitNotice(guildId, limits);
  if (limitNotice) {
    await textChannel.send(limitNotice);
    return false;
  }

  // Check if a meeting is already active
  if (hasMeeting(guildId)) {
    const meeting = getMeeting(guildId)!;
    if (!meeting.finished) {
      // Meeting already active, send notification about conflict
      await textChannel.send(
        `Cannot start auto-recording in **${voiceChannel.name}** - the bot is already recording in another channel.`,
      );
      return false;
    }
    // Clean up finished meeting
    deleteMeeting(guildId);
  }

  // Check if bot has necessary permissions
  const botMember = voiceChannel.guild.members.cache.get(client.user!.id);
  if (!botMember) {
    await textChannel.send(
      `Cannot start auto-recording - bot not found in server.`,
    );
    return false;
  }

  // Check bot permissions
  const permissionCheck = checkBotPermissions(
    voiceChannel,
    textChannel,
    botMember,
  );

  if (!permissionCheck.success) {
    // Try to send error message if we have text channel permissions
    try {
      await textChannel.send(
        `Cannot start auto-recording - ${permissionCheck.errorMessage}`,
      );
    } catch {
      console.error(
        `No permissions to send messages in text channel ${textChannel.id}`,
      );
    }
    return false;
  }

  // Initialize the meeting using the core function
  const meeting = await initializeMeeting({
    voiceChannel,
    textChannel,
    guild: voiceChannel.guild,
    creator: client.user!,
    transcribeMeeting: true, // Always transcribe for auto-recordings
    generateNotes: true, // Always generate notes for auto-recordings
    initialInteraction: undefined, // No interaction for auto-recordings
    isAutoRecording: true,
    startReason: options?.startReason,
    startTriggeredByUserId: options?.startTriggeredByUserId,
    autoRecordRule: options?.autoRecordRule,
    tags: options?.tags,
    onTimeout: (meeting) => handleEndMeetingOther(client, meeting),
    onEndMeeting: (meeting) => handleEndMeetingOther(client, meeting),
    liveVoiceEnabled: options?.liveVoiceEnabled,
    liveVoiceCommandsEnabled: options?.liveVoiceCommandsEnabled,
    liveVoiceTtsVoice: options?.liveVoiceTtsVoice,
    chatTtsEnabled: options?.chatTtsEnabled,
    chatTtsVoice: options?.chatTtsVoice,
    subscriptionTier: subscription.tier,
  });
  void saveMeetingStartToDatabase(meeting);

  // Send notification that auto-recording has started
  const embed = new EmbedBuilder()
    .setTitle("🔴 Auto-Recording Started")
    .setDescription(`Auto-recording has started in **${voiceChannel.name}**`)
    .addFields({
      name: "Start Time",
      value: `<t:${Math.floor(meeting.startTime.getTime() / 1000)}:F>`,
    })
    .addFields({
      name: "Tip",
      value:
        'Right click Chronote in voice and choose "Stop recording" to stop recording.',
    })
    .setColor(0xff0000)
    .setTimestamp();

  const endButton = new ButtonBuilder()
    .setCustomId("end_meeting")
    .setLabel("End Recording")
    .setStyle(ButtonStyle.Danger);

  const editTagsButton = new ButtonBuilder()
    .setCustomId("edit_tags")
    .setLabel("Edit Tags")
    .setStyle(ButtonStyle.Secondary);

  const liveMeetingUrl = buildLiveMeetingUrl(
    meeting.guildId,
    meeting.meetingId,
  );
  const liveMeetingButton = liveMeetingUrl
    ? new ButtonBuilder()
        .setLabel("Live transcript")
        .setStyle(ButtonStyle.Link)
        .setURL(liveMeetingUrl)
    : null;
  const components = [endButton, editTagsButton];
  if (liveMeetingButton) {
    components.push(liveMeetingButton);
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...components,
  );

  const message = await textChannel.send({
    embeds: [embed],
    components: [row],
  });
  meeting.startMessageId = message.id;

  return true;
}
