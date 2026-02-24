import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  ModalSubmitInteraction,
  Partials,
  RepliableInteraction,
  REST,
  SlashCommandBuilder,
  TextChannel,
  VoiceState,
  ChannelSelectMenuInteraction,
  Events,
} from "discord.js";
import { Routes } from "discord-api-types/v10";
import { CONFIG_KEYS } from "./config/keys";
import { getAllMeetings, getMeeting } from "./meetings";
import {
  handleRequestStartMeeting,
  handleAutoStartMeeting,
} from "./commands/startMeeting";
import { handleAutoRecordCommand } from "./commands/autorecord";
import { handleContextCommand } from "./commands/context";
import { getAutoRecordSettingByChannel } from "./services/autorecordService";
import { resolveMeetingVoiceSettings } from "./services/meetingVoiceSettingsService";
import {
  getSnapshotString,
  resolveConfigSnapshot,
} from "./services/unifiedConfigService";
import { getGuildLimits } from "./services/subscriptionService";
import {
  formatParticipantLabel,
  formatUserMention,
  fromMember,
} from "./utils/participants";
import { parseTags } from "./utils/tags";
import {
  handleEndMeetingButton,
  handleEndMeetingOther,
} from "./commands/endMeeting";
import { subscribeToUserVoice, unsubscribeToVoiceUponLeaving } from "./audio";
import { generateAndSendImage } from "./commands/generateImage";
import {
  handleNotesCorrectionButton,
  handleNotesCorrectionModal,
  isNotesCorrectionButton,
  isNotesCorrectionAccept,
  isNotesCorrectionReject,
  handleNotesCorrectionAccept,
  handleNotesCorrectionReject,
  isNotesCorrectionModal,
} from "./commands/notesCorrections";
import {
  handleSummaryFeedbackDown,
  handleSummaryFeedbackModal,
  handleSummaryFeedbackUp,
  isSummaryFeedbackDown,
  isSummaryFeedbackModal,
  isSummaryFeedbackUp,
} from "./commands/summaryFeedback";
import {
  handleAskFeedbackDown,
  handleAskFeedbackModal,
  handleAskFeedbackUp,
  isAskFeedbackDown,
  isAskFeedbackModal,
  isAskFeedbackUp,
} from "./commands/askFeedback";
import {
  handleFeedbackCommand,
  handleContactFeedbackModal,
  isContactFeedbackModal,
} from "./commands/contactFeedback";
import { config } from "./services/configService";
import {
  handleEditTagsButton,
  handleEditTagsModal,
  isEditTagsButton,
  isEditTagsModal,
  handleEditTagsHistoryButton,
  handleEditTagsHistoryModal,
  isEditTagsHistoryButton,
  isEditTagsHistoryModal,
} from "./commands/tags";
import {
  handleRenameMeetingButton,
  handleRenameMeetingModal,
  isRenameMeetingButton,
  isRenameMeetingModal,
} from "./commands/meetingName";
import { handleAskCommand } from "./commands/ask";
import { handleDictionaryCommand } from "./commands/dictionary";
import { billingCommand, handleBillingCommand } from "./commands/billing";
import { handleSayCommand } from "./commands/say";
import { handleTtsCommand } from "./commands/tts";
import { TTS_VOICE_OPTIONS } from "./utils/ttsVoices";
import {
  invalidateDiscordBotGuildsCache,
  invalidateDiscordGuildCache,
  invalidateDiscordUserCache,
} from "./services/discordCacheService";
import {
  handleOnboardButtonInteraction,
  handleOnboardChannelSelect,
  handleOnboardCommand,
  handleOnboardModalSubmit,
  isOnboardButton,
  isOnboardChannelSelect,
  isOnboardModal,
  onboardCommand,
} from "./commands/onboard";
import { fetchGuildInstaller } from "./services/guildInstallerService";
import { autoRecordJoinSuppressionService } from "./services/autoRecordJoinSuppressionService";
import {
  MEETING_END_REASONS,
  MEETING_START_REASONS,
  type AutoRecordRule,
} from "./types/meetingLifecycle";
import { isMeetingCollectingEvents } from "./utils/meetingLifecycle";
import {
  DISMISS_AUTORECORD_COMMAND_NAME,
  dismissAutoRecordCommand,
  handleDismissAutoRecord,
} from "./commands/dismissAutoRecord";
import { claimInteractionReceipt } from "./services/interactionIdempotencyService";
import { tryReplyToUnacknowledgedInteraction } from "./services/interactionResponseService";

const TOKEN = config.discord.botToken;
const CLIENT_ID = config.discord.clientId;
const TTS_VOICE_CHOICES = [
  { name: "Default (server)", value: "default" },
  ...TTS_VOICE_OPTIONS.map(({ label, value }) => ({
    name: label,
    value,
  })),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.User],
});

const replyOnboardingDisabled = async (interaction: RepliableInteraction) => {
  await interaction.reply({
    content: "Onboarding is currently disabled for this bot.",
    ephemeral: true,
  });
};

const invalidateGuildCache = async (guildId: string, label: string) => {
  try {
    await invalidateDiscordGuildCache(guildId);
  } catch (error) {
    console.warn(`${label} cache invalidation failed`, { guildId, error });
  }
};

const invalidateUserCache = async (userId: string, label: string) => {
  try {
    await invalidateDiscordUserCache(userId);
  } catch (error) {
    console.warn(`${label} cache invalidation failed`, { userId, error });
  }
};

const invalidateBotGuildCache = async (label: string) => {
  try {
    await invalidateDiscordBotGuildsCache();
  } catch (error) {
    console.warn(`${label} cache invalidation failed`, error);
  }
};

const commandHandlers: Record<
  string,
  (interaction: ChatInputCommandInteraction) => Promise<void>
> = {
  autorecord: handleAutoRecordCommand,
  ask: handleAskCommand,
  dictionary: handleDictionaryCommand,
  context: handleContextCommand,
  billing: handleBillingCommand,
  say: handleSayCommand,
  tts: handleTtsCommand,
  feedback: handleFeedbackCommand,
};

const handleCommandInteraction = async (
  interaction: ChatInputCommandInteraction,
) => {
  const { commandName } = interaction;
  if (commandName === "startmeeting") {
    await handleRequestStartMeeting(interaction);
    return;
  }
  if (commandName === "onboard") {
    if (!config.server.onboardingEnabled) {
      await replyOnboardingDisabled(interaction);
      return;
    }
    await handleOnboardCommand(interaction);
    return;
  }
  const handler = commandHandlers[commandName];
  if (handler) {
    await handler(interaction);
  }
};

const modalHandlers: Array<{
  matches: (customId: string) => boolean;
  handle: (interaction: ModalSubmitInteraction) => Promise<void>;
  onboarding?: boolean;
}> = [
  {
    matches: isAskFeedbackModal,
    handle: handleAskFeedbackModal,
  },
  {
    matches: isSummaryFeedbackModal,
    handle: handleSummaryFeedbackModal,
  },
  {
    matches: isContactFeedbackModal,
    handle: handleContactFeedbackModal,
  },
  {
    matches: isNotesCorrectionModal,
    handle: handleNotesCorrectionModal,
  },
  {
    matches: isEditTagsModal,
    handle: handleEditTagsModal,
  },
  {
    matches: isEditTagsHistoryModal,
    handle: handleEditTagsHistoryModal,
  },
  {
    matches: isRenameMeetingModal,
    handle: handleRenameMeetingModal,
  },
  {
    matches: isOnboardModal,
    handle: handleOnboardModalSubmit,
    onboarding: true,
  },
];

const handleModalInteraction = async (interaction: ModalSubmitInteraction) => {
  for (const entry of modalHandlers) {
    if (!entry.matches(interaction.customId)) continue;
    if (entry.onboarding && !config.server.onboardingEnabled) {
      await replyOnboardingDisabled(interaction);
      return;
    }
    await entry.handle(interaction);
    return;
  }
};

const buttonHandlers: Array<{
  matches: (customId: string) => boolean;
  handle: (interaction: ButtonInteraction) => Promise<void>;
  onboarding?: boolean;
}> = [
  {
    matches: isAskFeedbackUp,
    handle: handleAskFeedbackUp,
  },
  {
    matches: isAskFeedbackDown,
    handle: handleAskFeedbackDown,
  },
  {
    matches: isSummaryFeedbackUp,
    handle: handleSummaryFeedbackUp,
  },
  {
    matches: isSummaryFeedbackDown,
    handle: handleSummaryFeedbackDown,
  },
  {
    matches: isNotesCorrectionAccept,
    handle: handleNotesCorrectionAccept,
  },
  {
    matches: isNotesCorrectionReject,
    handle: handleNotesCorrectionReject,
  },
  {
    matches: isNotesCorrectionButton,
    handle: handleNotesCorrectionButton,
  },
  {
    matches: isEditTagsButton,
    handle: handleEditTagsButton,
  },
  {
    matches: isEditTagsHistoryButton,
    handle: handleEditTagsHistoryButton,
  },
  {
    matches: isRenameMeetingButton,
    handle: handleRenameMeetingButton,
  },
  {
    matches: isOnboardButton,
    handle: handleOnboardButtonInteraction,
    onboarding: true,
  },
];

const handleButtonInteraction = async (interaction: ButtonInteraction) => {
  for (const entry of buttonHandlers) {
    if (!entry.matches(interaction.customId)) continue;
    if (entry.onboarding && !config.server.onboardingEnabled) {
      await replyOnboardingDisabled(interaction);
      return;
    }
    await entry.handle(interaction);
    return;
  }

  if (interaction.customId === "end_meeting") {
    await handleEndMeetingButton(client, interaction);
    return;
  }
  if (interaction.customId === "generate_image") {
    await generateAndSendImage(interaction);
  }
};

const handleChannelSelectInteraction = async (
  interaction: ChannelSelectMenuInteraction,
) => {
  if (!isOnboardChannelSelect(interaction.customId)) return;
  if (!config.server.onboardingEnabled) {
    await replyOnboardingDisabled(interaction);
    return;
  }
  await handleOnboardChannelSelect(interaction);
};

const handleInteractionCreate = async (interaction: RepliableInteraction) => {
  if (interaction.isChatInputCommand()) {
    await handleCommandInteraction(interaction);
    return;
  }
  if (interaction.isUserContextMenuCommand()) {
    if (interaction.commandName === DISMISS_AUTORECORD_COMMAND_NAME) {
      await handleDismissAutoRecord(client, interaction);
      return;
    }
    await interaction.reply({
      content: "Unknown context menu command.",
      ephemeral: true,
    });
    return;
  }
  if (interaction.isModalSubmit()) {
    await handleModalInteraction(interaction);
    return;
  }
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
    return;
  }
  if (interaction.isChannelSelectMenu()) {
    await handleChannelSelectInteraction(interaction);
  }
};

const resolveInteractionKind = (interaction: RepliableInteraction): string => {
  if (interaction.isChatInputCommand()) {
    return `chat-input:${interaction.commandName}`;
  }
  if (interaction.isUserContextMenuCommand()) {
    return `user-context:${interaction.commandName}`;
  }
  if (interaction.isButton()) {
    return `button:${interaction.customId}`;
  }
  if (interaction.isModalSubmit()) {
    return `modal:${interaction.customId}`;
  }
  if (interaction.isChannelSelectMenu()) {
    return `channel-select:${interaction.customId}`;
  }
  return "other";
};

const tryClaimInteraction = async (
  interaction: RepliableInteraction,
): Promise<boolean> => {
  try {
    return await claimInteractionReceipt({
      interactionId: interaction.id,
      interactionKind: resolveInteractionKind(interaction),
      guildId: interaction.guildId ?? undefined,
    });
  } catch (error) {
    console.error(
      "Failed to claim interaction receipt, continuing without idempotency",
      {
        interactionId: interaction.id,
        error,
      },
    );
    return true;
  }
};

export async function setupBot() {
  if (!TOKEN || !CLIENT_ID) {
    throw new Error(
      "Bot token or client ID is not defined in the environment variables",
    );
  }

  client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user?.tag}!`);

    client.on("voiceStateUpdate", handleVoiceStateUpdate);
  });

  client.on("guildCreate", async (guild) => {
    await invalidateBotGuildCache("guildCreate");
    await invalidateGuildCache(guild.id, "guildCreate");
    if (!config.server.onboardingEnabled) {
      return;
    }
    try {
      const installer = await fetchGuildInstaller(guild.id);
      const dmTarget =
        installer?.installerId &&
        (await client.users.fetch(installer.installerId).catch(() => null));
      const recipient = dmTarget ?? (await guild.fetchOwner());
      if (recipient) {
        const targetUser = "user" in recipient ? recipient.user : recipient;
        await targetUser.send(
          "Thanks for adding Meeting Notes Bot! Run `/onboard` in your server (Manage Guild required) for a 1-minute setup.",
        );
      }
    } catch (err) {
      console.warn("Could not DM installer/owner on join", err);
    }
  });

  client.on("guildDelete", async (guild) => {
    await invalidateBotGuildCache("guildDelete");
    await invalidateGuildCache(guild.id, "guildDelete");
  });

  client.on("guildUpdate", async (_oldGuild, newGuild) => {
    await invalidateGuildCache(newGuild.id, "guildUpdate");
  });

  client.on("channelCreate", async (channel) => {
    const guildId = channel.guild?.id;
    if (!guildId) return;
    await invalidateGuildCache(guildId, "channelCreate");
  });

  client.on("channelUpdate", async (_oldChannel, newChannel) => {
    if (newChannel.isDMBased()) return;
    await invalidateGuildCache(newChannel.guild.id, "channelUpdate");
  });

  client.on("channelDelete", async (channel) => {
    if (channel.isDMBased()) return;
    await invalidateGuildCache(channel.guild.id, "channelDelete");
  });

  client.on("roleCreate", async (role) => {
    await invalidateGuildCache(role.guild.id, "roleCreate");
  });

  client.on("roleUpdate", async (_oldRole, newRole) => {
    await invalidateGuildCache(newRole.guild.id, "roleUpdate");
  });

  client.on("roleDelete", async (role) => {
    await invalidateGuildCache(role.guild.id, "roleDelete");
  });

  client.on("guildMemberAdd", async (member) => {
    await invalidateUserCache(member.id, "guildMemberAdd");
    await invalidateGuildCache(member.guild.id, "guildMemberAdd");
  });

  client.on("guildMemberRemove", async (member) => {
    await invalidateUserCache(member.id, "guildMemberRemove");
    await invalidateGuildCache(member.guild.id, "guildMemberRemove");
  });

  client.on("guildMemberUpdate", async (_oldMember, newMember) => {
    await invalidateUserCache(newMember.id, "guildMemberUpdate");
    await invalidateGuildCache(newMember.guild.id, "guildMemberUpdate");
  });

  client.on("interactionCreate", async (interaction) => {
    if (isShuttingDown) {
      // Assume another instance has already been spun up to handle traffic, and don't handle it
      console.log(
        "Interaction received but bot is shutting down. Not handling",
      );
      return;
    }
    try {
      if (interaction.isRepliable()) {
        const claimed = await tryClaimInteraction(interaction);
        if (!claimed) {
          console.log("Skipping duplicate interaction", {
            interactionId: interaction.id,
            interactionKind: resolveInteractionKind(interaction),
          });
          return;
        }
        await handleInteractionCreate(interaction);
      }
    } catch (e) {
      console.error("Unknown error processing command: ", e);
      try {
        if (interaction.isRepliable()) {
          const sent = await tryReplyToUnacknowledgedInteraction(
            interaction,
            "Unknown Error handling request.",
          );
          if (!sent) {
            console.log(
              "Skipped unknown error reply because interaction is acknowledged",
              {
                interactionId: interaction.id,
                interactionKind: resolveInteractionKind(interaction),
              },
            );
          }
        }
      } catch (e2) {
        console.error("Error replying to interaction about initial error", e2);
      }
    }
  });

  setupApplicationCommands();

  client.login(TOKEN);
}

async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
) {
  recordSuppressionVoiceState(oldState, newState);
  const botId = client.user?.id;
  if (
    botId &&
    (oldState.member?.id === botId || newState.member?.id === botId)
  ) {
    await handleBotVoiceUpdate(oldState, newState);
  }
  // Check if the user switched channels
  if (
    oldState.channel &&
    newState.channel &&
    oldState.channelId !== newState.channelId
  ) {
    // Handle as leave from old channel
    await handleUserLeave(oldState);
    // Handle as join to new channel
    await handleUserJoin(newState);
  }
  // Check if the user joined a voice channel
  else if (!oldState.channel && newState.channel && newState.member) {
    await handleUserJoin(newState);
  }
  // Check if the user left a voice channel
  else if (oldState.channel && !newState.channel && oldState.member) {
    await handleUserLeave(oldState);
  }
}

function recordSuppressionVoiceState(
  oldState: VoiceState,
  newState: VoiceState,
) {
  const userId = newState.id || oldState.id;
  if (!userId) return;
  const member = newState.member ?? oldState.member;
  const botUserId = client.user?.id;
  const isBot =
    member?.user.bot === true ||
    (botUserId !== undefined && botUserId === userId);
  const result = autoRecordJoinSuppressionService.handleVoiceStateChange({
    guildId: newState.guild.id,
    userId,
    isBot,
    oldChannelId: oldState.channelId,
    newChannelId: newState.channelId,
  });
  if (result.clearedSuppression) {
    const extra = result.clearedSuppressionInfo
      ? ` reason=${result.clearedSuppressionInfo.reason} suppressedAt=${result.clearedSuppressionInfo.createdAt}`
      : "";
    console.log(
      `Auto-record suppression cleared after channel became empty: guildId=${newState.guild.id} channelId=${oldState.channelId}${extra}`,
    );
  }
}

async function handleBotVoiceUpdate(
  oldState: VoiceState,
  newState: VoiceState,
) {
  const meeting = getMeeting(oldState.guild.id);
  if (!isMeetingCollectingEvents(meeting)) return;
  const wasInMeetingChannel = oldState.channelId === meeting.voiceChannel.id;
  const stillInMeetingChannel = newState.channelId === meeting.voiceChannel.id;
  if (wasInMeetingChannel && !stillInMeetingChannel) {
    if (meeting.isAutoRecording) {
      const nonBotMemberIds = meeting.voiceChannel.members
        .filter((member) => !member.user.bot)
        .map((member) => member.id);
      const didSuppress = autoRecordJoinSuppressionService.suppressUntilEmpty({
        guildId: meeting.guildId,
        channelId: meeting.voiceChannel.id,
        nonBotMemberIds,
        reason: "forced_disconnect",
      });
      if (!didSuppress) {
        console.log(
          `Auto-record suppression not set after forced disconnect (already suppressed or channel empty): guildId=${meeting.guildId} channelId=${meeting.voiceChannel.id} nonBotMembers=${nonBotMemberIds.length}`,
        );
      }
    }
    meeting.endReason = MEETING_END_REASONS.BOT_DISCONNECT;
    const notice = await meeting.textChannel.send(
      "Meeting ending because the bot was disconnected from the voice channel.",
    );
    if (meeting.isAutoRecording) {
      if (!meeting.messagesToDelete) {
        meeting.messagesToDelete = [];
      }
      meeting.messagesToDelete.push(notice.id);
    }
    await handleEndMeetingOther(client, meeting);
  }
}

async function handleUserJoin(newState: VoiceState) {
  const meeting = getMeeting(newState.guild.id);

  // Handle existing meeting attendance
  if (
    isMeetingCollectingEvents(meeting) &&
    newState.member &&
    newState.member.user.id !== client.user!.id &&
    meeting.voiceChannel.id === newState.channelId
  ) {
    const participant = fromMember(newState.member);
    const userLabel = formatParticipantLabel(participant, {
      includeUsername: false,
      fallbackName: newState.member.user.username,
    });
    console.log(`${userLabel} joined the voice channel.`);
    meeting.attendance.add(formatUserMention(participant.id));
    meeting.participants.set(participant.id, participant);
    meeting.chatLog.push({
      type: "join",
      user: participant,
      channelId: newState.channelId!,
      timestamp: new Date().toISOString(),
    });

    await subscribeToUserVoice(meeting, newState.member!.user.id);
    return; // Exit early if we're already recording
  }

  // Check if auto-record is enabled for this channel
  if (
    !meeting &&
    newState.channel &&
    newState.member &&
    newState.member.user.id !== client.user!.id // Don't trigger for bot joining
  ) {
    if (
      autoRecordJoinSuppressionService.shouldSuppressAutoJoin(
        newState.guild.id,
        newState.channelId!,
      )
    ) {
      console.log(
        `Auto-record suppressed for channel ${newState.channelId} until it becomes empty again.`,
      );
      return;
    }
    try {
      // Check for specific channel setting
      let autoRecordSetting = await getAutoRecordSettingByChannel(
        newState.guild.id,
        newState.channelId!,
      );

      // If no specific setting, check for record-all setting
      if (!autoRecordSetting) {
        autoRecordSetting = await getAutoRecordSettingByChannel(
          newState.guild.id,
          "ALL",
        );
      }

      // If auto-record is enabled, start recording
      if (autoRecordSetting && autoRecordSetting.enabled) {
        let defaultNotesChannelId: string | undefined;
        let defaultTags: string[] | undefined;
        const { subscription, limits } = await getGuildLimits(
          newState.guild.id,
        );
        try {
          const snapshot = await resolveConfigSnapshot({
            guildId: newState.guild.id,
            tier: subscription.tier,
          });
          defaultNotesChannelId = getSnapshotString(
            snapshot,
            CONFIG_KEYS.notes.channelId,
            { trim: true },
          );
          const notesTagsValue = getSnapshotString(
            snapshot,
            CONFIG_KEYS.notes.tags,
            { trim: true },
          );
          if (notesTagsValue) {
            defaultTags = parseTags(notesTagsValue);
          }
        } catch (error) {
          console.error("Failed to resolve server config defaults", error);
        }
        const resolvedTextChannelId =
          autoRecordSetting.textChannelId ?? defaultNotesChannelId;
        if (!resolvedTextChannelId) {
          console.error(
            `No default notes channel configured for auto-record in guild ${newState.guild.id}`,
          );
          return;
        }
        const textChannel = newState.guild.channels.cache.get(
          resolvedTextChannelId,
        ) as TextChannel;

        if (textChannel && newState.channel) {
          console.log(
            `Auto-starting recording in ${newState.channel.name} due to auto-record settings`,
          );
          const {
            liveVoiceEnabled,
            liveVoiceCommandsEnabled,
            liveVoiceTtsVoice,
            chatTtsEnabled,
            chatTtsVoice,
          } = await resolveMeetingVoiceSettings(
            newState.guild.id,
            newState.channelId!,
            limits,
          );
          const tags = autoRecordSetting.tags ?? defaultTags;
          const startReason = autoRecordSetting.recordAll
            ? MEETING_START_REASONS.AUTO_RECORD_ALL
            : MEETING_START_REASONS.AUTO_RECORD_CHANNEL;
          const startTriggeredByUserId = newState.member.user.id;
          const autoRecordRule: AutoRecordRule = {
            mode: autoRecordSetting.recordAll ? "all" : "channel",
            channelId: autoRecordSetting.channelId,
          };
          await handleAutoStartMeeting(client, newState.channel, textChannel, {
            tags,
            liveVoiceEnabled,
            liveVoiceCommandsEnabled,
            liveVoiceTtsVoice,
            chatTtsEnabled,
            chatTtsVoice,
            startReason,
            startTriggeredByUserId,
            autoRecordRule,
          });
        } else {
          console.error(
            `Could not find text channel ${resolvedTextChannelId} for auto-recording`,
          );
        }
      }
    } catch (error) {
      console.error("Error checking auto-record settings:", error);
    }
  }
}

async function handleUserLeave(oldState: VoiceState) {
  const meeting = getMeeting(oldState.guild.id);
  if (
    isMeetingCollectingEvents(meeting) &&
    oldState.member &&
    oldState.member.user.id !== client.user!.id &&
    meeting.voiceChannel.id === oldState.channelId
  ) {
    const participant = fromMember(oldState.member);
    const userLabel = formatParticipantLabel(participant, {
      includeUsername: false,
      fallbackName: oldState.member.user.username,
    });
    console.log(`${userLabel} left the voice channel.`);
    meeting.participants.set(participant.id, participant);
    meeting.chatLog.push({
      type: "leave",
      user: participant,
      channelId: oldState.channelId!,
      timestamp: new Date().toISOString(),
    });

    unsubscribeToVoiceUponLeaving(meeting, oldState.member!.user.id);

    if (
      meeting.voiceChannel.members.size <= 1 &&
      !meeting.finishing &&
      !meeting.finished
    ) {
      if (!meeting.endReason) {
        meeting.endReason = MEETING_END_REASONS.CHANNEL_EMPTY;
      }
      const notice = await meeting.textChannel.send(
        "Meeting ending due to nobody being left in the voice channel.",
      );
      if (meeting.isAutoRecording) {
        if (!meeting.messagesToDelete) {
          meeting.messagesToDelete = [];
        }
        meeting.messagesToDelete.push(notice.id);
      }
      await handleEndMeetingOther(client, meeting);
    }
  }
}

async function setupApplicationCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("startmeeting")
      .setDescription("Record a meeting with voice and chat logs.")
      .addStringOption((option) =>
        option
          .setName("context")
          .setDescription(
            'Optional context about this meeting (e.g., "Sprint planning for Q1 features")',
          )
          .setRequired(false)
          .setMaxLength(500),
      )
      .addStringOption((option) =>
        option
          .setName("tags")
          .setDescription("Optional comma-separated tags for this meeting")
          .setRequired(false)
          .setMaxLength(500),
      ),
    new SlashCommandBuilder()
      .setName("autorecord")
      .setDescription("Configure automatic recording for voice channels")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable")
          .setDescription("Enable auto-recording for a specific voice channel")
          .addChannelOption((option) =>
            option
              .setName("voice-channel")
              .setDescription("The voice channel to auto-record")
              .addChannelTypes(2)
              .setRequired(true),
          )
          .addChannelOption((option) =>
            option
              .setName("text-channel")
              .setDescription("The text channel to send meeting notifications")
              .addChannelTypes(0)
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("tags")
              .setDescription("Optional comma-separated tags to apply")
              .setRequired(false)
              .setMaxLength(500),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription("Disable auto-recording for a specific voice channel")
          .addChannelOption((option) =>
            option
              .setName("voice-channel")
              .setDescription("The voice channel to stop auto-recording")
              .addChannelTypes(2)
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable-all")
          .setDescription("Enable auto-recording for all voice channels")
          .addChannelOption((option) =>
            option
              .setName("text-channel")
              .setDescription("The text channel to send meeting notifications")
              .addChannelTypes(0)
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("tags")
              .setDescription("Optional comma-separated tags to apply")
              .setRequired(false)
              .setMaxLength(500),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable-all")
          .setDescription("Disable auto-recording for all voice channels"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List all auto-record settings for this server"),
      ),
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask about past meetings")
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("Your question")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("tags")
          .setDescription("Optional comma-separated tags to filter meetings")
          .setRequired(false)
          .setMaxLength(500),
      )
      .addStringOption((option) =>
        option
          .setName("scope")
          .setDescription("Search scope")
          .addChoices(
            { name: "Guild (default)", value: "guild" },
            { name: "Channel only", value: "channel" },
          )
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("tts")
      .setDescription("Control chat-to-speech preferences")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription("Do not speak your chat messages in meetings"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("enable")
          .setDescription("Allow your chat messages to be spoken in meetings"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("voice")
          .setDescription("Set your chat-to-speech voice for this server")
          .addStringOption((option) =>
            option
              .setName("voice")
              .setDescription('Voice name (or "default" to reset)')
              .setRequired(true)
              .setMaxLength(32)
              .addChoices(...TTS_VOICE_CHOICES),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("stop")
          .setDescription("Stop current bot playback and clear the queue"),
      ),
    new SlashCommandBuilder()
      .setName("say")
      .setDescription("Speak a message aloud in the meeting voice channel")
      .addStringOption((option) => {
        option
          .setName("message")
          .setDescription("Message to speak aloud")
          .setRequired(true);
        const maxLength = config.chatTts.maxChars;
        if (maxLength > 0 && maxLength <= 6000) {
          option.setMaxLength(maxLength);
        }
        return option;
      }),
    billingCommand,
    new SlashCommandBuilder()
      .setName("context")
      .setDescription(
        "Manage context settings for better meeting understanding",
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set-server")
          .setDescription("Set server-wide context for all meetings")
          .addStringOption((option) =>
            option
              .setName("context")
              .setDescription(
                "Context/instructions for the server (max 2000 chars)",
              )
              .setRequired(true)
              .setMaxLength(2000),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set-channel")
          .setDescription("Set context for a specific voice channel")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("The voice channel to set context for")
              .addChannelTypes(2) // Voice channel type
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("context")
              .setDescription(
                "Context/instructions for the channel (max 2000 chars)",
              )
              .setRequired(true)
              .setMaxLength(2000),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("view")
          .setDescription("View current context settings")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Optional: View context for a specific channel")
              .addChannelTypes(2) // Voice channel type
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear-server")
          .setDescription("Clear server-wide context"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear-channel")
          .setDescription("Clear context for a specific channel")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("The voice channel to clear context for")
              .addChannelTypes(2) // Voice channel type
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List all contexts in this server"),
      ),
    new SlashCommandBuilder()
      .setName("dictionary")
      .setDescription("Manage dictionary terms for better transcription")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List dictionary entries for this server"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Add or update a dictionary entry")
          .addStringOption((option) =>
            option
              .setName("term")
              .setDescription("Word or phrase to capture")
              .setRequired(true)
              .setMaxLength(80),
          )
          .addStringOption((option) =>
            option
              .setName("definition")
              .setDescription("Optional definition or explanation")
              .setRequired(false)
              .setMaxLength(400),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a dictionary entry")
          .addStringOption((option) =>
            option
              .setName("term")
              .setDescription("Term to remove")
              .setRequired(true)
              .setMaxLength(80),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear")
          .setDescription("Remove all dictionary entries for this server"),
      ),
    dismissAutoRecordCommand,
    new SlashCommandBuilder()
      .setName("feedback")
      .setDescription("Send feedback, report a bug, or suggest a feature"),
  ];

  if (config.server.onboardingEnabled) {
    commands.push(onboardCommand);
  }

  const commandPayload = commands.map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    console.log("Started refreshing application (/) commands.");

    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: commandPayload,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
}

// Signal listener to start graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Received SIGTERM, initiating graceful shutdown");

  // Stop accepting new meetings/requests
  stopHandlingNewMeetings();

  // Wait for ongoing meetings to finish
  await completeOngoingMeetings();

  // Shut down the bot gracefully
  console.log("Shutting down...");
  process.exit(0); // Exit the process when all meetings are done
});
let isShuttingDown = false;

function stopHandlingNewMeetings() {
  isShuttingDown = true;
}

async function completeOngoingMeetings() {
  const meetings = getAllMeetings();
  if (meetings.length > 0) {
    console.log("Waiting for ongoing meetings to finish...");
    await Promise.all(meetings.map((meeting) => meeting.isFinished));
  } else {
    console.log("No ongoing meetings, ready to shut down.");
  }
}
