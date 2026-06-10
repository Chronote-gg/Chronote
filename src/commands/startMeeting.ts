import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  PermissionsBitField,
  TextChannel,
  User,
  UserContextMenuCommandInteraction,
  VoiceBasedChannel,
} from "discord.js";
import {
  deleteMeeting,
  getMeeting,
  hasMeeting,
  initializeMeeting,
} from "../meetings";
import { randomUUID } from "node:crypto";
import { GuildChannel } from "discord.js/typings";
import {
  buildAutoRecordPermissionChannelMessage,
  buildAutoRecordPermissionDmMessage,
  canBotSendMessages,
  checkBotPermissions,
  getMissingMeetingTextChannelPermissions,
  getMissingVoiceChannelPermissions,
} from "../utils/permissions";
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
import type { MeetingData } from "../types/meeting-data";
import {
  getActiveMeetingLeaseForGuild,
  getCurrentMeetingLeaseOwnerInstanceId,
  isLeaseActive,
  releaseMeetingLeaseByIdentifiers,
  startMeetingLeaseHeartbeat,
  tryAcquireMeetingLease,
} from "../services/activeMeetingLeaseService";
import { fetchGuildMember } from "../utils/guildMembers";
import type { ChatTtsSpeakerPrefixMode } from "../utils/ttsText";

type GuildLimits = Awaited<ReturnType<typeof getGuildLimits>>["limits"];

type StartMeetingInteraction =
  | ChatInputCommandInteraction
  | UserContextMenuCommandInteraction;

type StartMeetingOptions = {
  deferredEphemeralReply?: boolean;
  ephemeralErrors?: boolean;
};

type StartManualMeetingFromChannelsOptions = {
  client: Client;
  guild: Guild;
  voiceChannel: VoiceBasedChannel;
  textChannel: TextChannel;
  creator: User;
  meetingContext?: string;
  tags?: string[];
  startReason?: MeetingStartReason;
  startTriggeredByUserId: string;
};

type StartManualMeetingFromChannelsResult =
  | { ok: true; meeting: MeetingData; liveMeetingUrl: string | null }
  | { ok: false; error: string; upgradePrompt?: boolean };

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

const sendAutoRecordStartBlockedMessage = async (
  textChannel: TextChannel,
  message: string,
) => {
  try {
    await textChannel.send(message);
  } catch (error) {
    console.warn("Failed to send auto-record start failure message", {
      guildId: textChannel.guild.id,
      textChannelId: textChannel.id,
      error,
    });
  }
};

const fetchAutoRecordTriggerMember = async (
  guild: Guild,
  userId?: string,
): Promise<GuildMember | null> => {
  if (!userId) return null;
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;

  try {
    return await guild.members.fetch(userId);
  } catch (error) {
    console.warn("Failed to fetch auto-record trigger member", {
      guildId: guild.id,
      userId,
      error,
    });
    return null;
  }
};

const notifyAutoRecordPermissionFailure = async (options: {
  voiceChannel: VoiceBasedChannel;
  textChannel: TextChannel;
  botMember: GuildMember;
  startTriggeredByUserId?: string;
}) => {
  const { voiceChannel, textChannel, botMember, startTriggeredByUserId } =
    options;
  const missingVoicePermissions = getMissingVoiceChannelPermissions(
    voiceChannel,
    botMember,
  );
  const missingTextPermissions = getMissingMeetingTextChannelPermissions(
    textChannel,
    botMember,
  );
  const summary = {
    voiceChannelName: voiceChannel.name,
    textChannelName: textChannel.name,
    missingVoicePermissions,
    missingTextPermissions,
  };

  if (canBotSendMessages(textChannel, botMember)) {
    await sendAutoRecordStartBlockedMessage(
      textChannel,
      buildAutoRecordPermissionChannelMessage(summary),
    );
    return;
  }

  const triggerMember = await fetchAutoRecordTriggerMember(
    voiceChannel.guild,
    startTriggeredByUserId,
  );
  if (!triggerMember) {
    console.warn("Cannot DM auto-record start failure without trigger member", {
      guildId: voiceChannel.guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
      missingVoicePermissions,
      missingTextPermissions,
    });
    return;
  }

  const isAdmin = triggerMember.permissions.has(
    PermissionsBitField.Flags.ManageChannels,
  );
  try {
    await triggerMember.send(
      buildAutoRecordPermissionDmMessage({ ...summary, isAdmin }),
    );
  } catch (error) {
    console.warn("Failed to DM auto-record start failure", {
      guildId: voiceChannel.guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
      userId: triggerMember.id,
      missingVoicePermissions,
      missingTextPermissions,
      error,
    });
  }
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

const getMeetingRequestOptions = (interaction: StartMeetingInteraction) => {
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

const replyStartMeetingError = async (
  interaction: StartMeetingInteraction,
  content: string,
  options?: StartMeetingOptions,
) => {
  if (options?.deferredEphemeralReply) {
    await interaction.editReply(content);
    return;
  }

  if (!options?.ephemeralErrors) {
    await interaction.reply(content);
    return;
  }

  await interaction.reply({ content, ephemeral: true });
};

type GuildChannelResult =
  | {
      ok: true;
      guild: NonNullable<StartMeetingInteraction["guild"]>;
      guildChannel: GuildChannel;
      textChannel: TextChannel;
    }
  | { ok: false; error: string };

const resolveGuildChannels = (
  interaction: StartMeetingInteraction,
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

const resolveBotMember = (
  guild: NonNullable<StartMeetingInteraction["guild"]>,
) => {
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

const ensureNoActiveMeeting = async (guildId: string) => {
  if (hasMeeting(guildId)) {
    const meeting = getMeeting(guildId);
    if (meeting && !meeting.finished) {
      return "A meeting is already active in this server.";
    }
    deleteMeeting(guildId);
  }

  const lease = await getActiveMeetingLeaseForGuild(guildId);
  if (lease && isLeaseActive(lease)) {
    return "A meeting is already active in this server.";
  }

  return null;
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

export async function startManualMeetingFromChannels({
  client,
  guild,
  voiceChannel,
  textChannel,
  creator,
  meetingContext,
  tags,
  startReason = MEETING_START_REASONS.MANUAL_COMMAND,
  startTriggeredByUserId,
}: StartManualMeetingFromChannelsOptions): Promise<StartManualMeetingFromChannelsResult> {
  const guildId = guild.id;
  const meetingConflict = await ensureNoActiveMeeting(guildId);
  if (meetingConflict) {
    return { ok: false, error: meetingConflict };
  }

  const { limits, subscription } = await getGuildLimits(guildId);
  const limitNotice = await getLimitNotice(guildId, limits);
  if (limitNotice) {
    return { ok: false, error: limitNotice, upgradePrompt: true };
  }

  const botMember = resolveBotMember(guild);
  if (!botMember) {
    return { ok: false, error: "Bot not found in guild." };
  }

  const permissionCheck = checkBotPermissions(
    voiceChannel,
    textChannel,
    botMember,
  );
  if (!permissionCheck.success) {
    return {
      ok: false,
      error: permissionCheck.errorMessage ?? "Missing bot permissions.",
    };
  }

  const {
    liveVoiceEnabled,
    liveVoiceCommandsEnabled,
    chatTtsEnabled,
    chatTtsVoice,
    chatTtsSpeakerPrefixMode,
    liveVoiceTtsVoice,
  } = await resolveMeetingVoiceSettings(guildId, voiceChannel.id, limits);

  const meetingId = randomUUID();
  const leaseOwnerInstanceId = getCurrentMeetingLeaseOwnerInstanceId();
  const leaseAcquired = await tryAcquireMeetingLease({
    guildId,
    meetingId,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    textChannelId: textChannel.id,
    isAutoRecording: false,
    startReason,
    startTriggeredByUserId,
  });
  if (!leaseAcquired) {
    return { ok: false, error: "A meeting is already active in this server." };
  }

  let meeting;
  try {
    meeting = await initializeMeeting({
      meetingId,
      leaseOwnerInstanceId,
      voiceChannel,
      textChannel,
      guild,
      creator,
      transcribeMeeting: true,
      generateNotes: true,
      meetingContext,
      initialInteraction: undefined,
      isAutoRecording: false,
      startReason,
      startTriggeredByUserId,
      tags,
      onTimeout: (meeting) => handleEndMeetingOther(client, meeting),
      onEndMeeting: (meeting) => handleEndMeetingOther(client, meeting),
      liveVoiceEnabled,
      liveVoiceCommandsEnabled,
      liveVoiceTtsVoice,
      chatTtsEnabled,
      chatTtsVoice,
      chatTtsSpeakerPrefixMode,
      maxMeetingDurationMs: limits.maxMeetingDurationMs,
      maxMeetingDurationPretty: limits.maxMeetingDurationPretty,
      subscriptionTier: subscription.tier,
    });
  } catch (error) {
    await releaseMeetingLeaseByIdentifiers(
      guildId,
      meetingId,
      leaseOwnerInstanceId,
    );
    throw error;
  }
  startMeetingLeaseHeartbeat(meeting);
  void saveMeetingStartToDatabase(meeting);

  return {
    ok: true,
    meeting,
    liveMeetingUrl: buildLiveMeetingUrl(meeting.guildId, meeting.meetingId),
  };
}

export function buildManualMeetingStartedMessage(
  meeting: MeetingData,
  liveMeetingUrl: string | null,
) {
  const embed = new EmbedBuilder()
    .setTitle("Meeting Started")
    .setDescription(
      `The meeting has started in **${meeting.voiceChannel.name}**.`,
    )
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

  if (meeting.meetingContext) {
    embed.addFields({
      name: "Meeting Context",
      value: meeting.meetingContext,
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

  return { embeds: [embed], components: [row] };
}

export async function handleRequestStartMeeting(
  interaction: StartMeetingInteraction,
  options?: StartMeetingOptions,
) {
  const guildId = interaction.guildId!;
  const { meetingContext, tags } = getMeetingRequestOptions(interaction);
  const channelResult = resolveGuildChannels(interaction);
  if (!channelResult.ok) {
    await replyStartMeetingError(interaction, channelResult.error, options);
    return;
  }

  const { guild, guildChannel, textChannel } = channelResult;
  const botMember = resolveBotMember(guild);
  if (!botMember) {
    await replyStartMeetingError(
      interaction,
      "Bot not found in guild.",
      options,
    );
    return;
  }

  const permissionError = ensureBotCanSend(guildChannel, botMember);
  if (permissionError) {
    await replyStartMeetingError(interaction, permissionError, options);
    return;
  }

  const meetingConflict = await ensureNoActiveMeeting(guildId);
  if (meetingConflict) {
    await replyStartMeetingError(interaction, meetingConflict, options);
    return;
  }

  const member = await fetchGuildMember(guild, interaction.user.id);
  if (!member) {
    await replyStartMeetingError(
      interaction,
      "Unable to find your server member profile.",
      options,
    );
    return;
  }
  const voiceResult = resolveMemberVoiceChannel(member);
  if (!voiceResult.ok) {
    await replyStartMeetingError(interaction, voiceResult.error, options);
    return;
  }
  const { voiceChannel } = voiceResult;

  const startResult = await startManualMeetingFromChannels({
    client: interaction.client,
    guild,
    voiceChannel,
    textChannel,
    creator: interaction.user,
    meetingContext,
    tags,
    startTriggeredByUserId: interaction.user.id,
  });
  if (!startResult.ok) {
    if (startResult.upgradePrompt) {
      if (options?.deferredEphemeralReply) {
        const upgradePrompt = buildUpgradePrompt(startResult.error);
        await interaction.editReply({
          components: upgradePrompt.components,
          content: upgradePrompt.content,
        });
        return;
      }
      await interaction.reply(buildUpgradePrompt(startResult.error));
      return;
    }
    await replyStartMeetingError(interaction, startResult.error, options);
    return;
  }

  const { meeting, liveMeetingUrl } = startResult;

  if (options?.deferredEphemeralReply) {
    const message = await textChannel.send(
      buildManualMeetingStartedMessage(meeting, liveMeetingUrl),
    );
    meeting.startMessageId = message.id;
    await interaction.editReply(
      `Meeting started in **${meeting.voiceChannel.name}**.`,
    );
    return;
  }

  const reply = await interaction.reply({
    ...buildManualMeetingStartedMessage(meeting, liveMeetingUrl),
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
    chatTtsSpeakerPrefixMode?: ChatTtsSpeakerPrefixMode;
    startReason?: MeetingStartReason;
    startTriggeredByUserId?: string;
    autoRecordRule?: AutoRecordRule;
  },
) {
  const guildId = voiceChannel.guild.id;
  const botMember = voiceChannel.guild.members.cache.get(client.user!.id);
  if (!botMember) {
    await textChannel.send(
      `Cannot start auto-recording - bot not found in server.`,
    );
    return false;
  }

  const permissionCheck = checkBotPermissions(
    voiceChannel,
    textChannel,
    botMember,
  );

  if (!permissionCheck.success) {
    await notifyAutoRecordPermissionFailure({
      voiceChannel,
      textChannel,
      botMember,
      startTriggeredByUserId: options?.startTriggeredByUserId,
    });
    return false;
  }

  const staleLease = await getActiveMeetingLeaseForGuild(guildId);
  if (staleLease && isLeaseActive(staleLease)) {
    await textChannel.send(
      `Cannot start auto-recording in **${voiceChannel.name}** - a meeting is already active in this server.`,
    );
    return false;
  }
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

  const meetingId = randomUUID();
  const leaseOwnerInstanceId = getCurrentMeetingLeaseOwnerInstanceId();
  const leaseAcquired = await tryAcquireMeetingLease({
    guildId,
    meetingId,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    textChannelId: textChannel.id,
    isAutoRecording: true,
    startReason: options?.startReason,
    startTriggeredByUserId: options?.startTriggeredByUserId,
    autoRecordRule: options?.autoRecordRule,
  });
  if (!leaseAcquired) {
    await textChannel.send(
      `Cannot start auto-recording in **${voiceChannel.name}** - a meeting is already active in this server.`,
    );
    return false;
  }

  // Initialize the meeting using the core function
  let meeting;
  try {
    meeting = await initializeMeeting({
      meetingId,
      leaseOwnerInstanceId,
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
      chatTtsSpeakerPrefixMode: options?.chatTtsSpeakerPrefixMode,
      subscriptionTier: subscription.tier,
    });
  } catch (error) {
    await releaseMeetingLeaseByIdentifiers(
      guildId,
      meetingId,
      leaseOwnerInstanceId,
    );
    throw error;
  }
  startMeetingLeaseHeartbeat(meeting);
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
        'Right click Chronote in voice and choose "Stop recording" to end the meeting.',
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
