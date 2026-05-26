import {
  ChatInputCommandInteraction,
  PermissionsBitField,
  EmbedBuilder,
  ChannelType,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";
import {
  getAutoRecordSettingByChannel,
  listAutoRecordSettings,
  removeAutoRecordSetting,
  saveAutoRecordSetting,
} from "../services/autorecordService";
import { CONFIG_KEYS } from "../config/keys";
import { resolveConfigString } from "../services/unifiedConfigService";
import { parseTags } from "../utils/tags";
import {
  checkBotPermissions,
  formatMissingPermissions,
  getMissingMeetingTextChannelPermissions,
} from "../utils/permissions";

export async function handleAutoRecordCommand(
  interaction: ChatInputCommandInteraction,
) {
  const subcommand = interaction.options.getSubcommand();

  if (!interaction.guild || !interaction.member) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  // Check permissions
  const member = interaction.guild.members.cache.get(interaction.user.id);
  if (
    !member ||
    !member.permissions.has(PermissionsBitField.Flags.ManageChannels)
  ) {
    await interaction.reply({
      content: "You need the 'Manage Channels' permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  switch (subcommand) {
    case "enable":
      await handleEnableAutoRecord(interaction);
      break;
    case "disable":
      await handleDisableAutoRecord(interaction);
      break;
    case "enable-all":
      await handleEnableAllAutoRecord(interaction);
      break;
    case "disable-all":
      await handleDisableAutoRecordAll(interaction);
      break;
    case "list":
      await handleListAutoRecord(interaction);
      break;
    default:
      await interaction.reply({
        content: "Unknown subcommand.",
        ephemeral: true,
      });
  }
}

async function handleEnableAutoRecord(
  interaction: ChatInputCommandInteraction,
) {
  const voiceChannelOption = interaction.options.getChannel("voice-channel");
  const textChannelOption = interaction.options.getChannel("text-channel");

  if (!voiceChannelOption || !textChannelOption) {
    await interaction.reply({
      content: "Both voice channel and text channel are required.",
      ephemeral: true,
    });
    return;
  }

  const voiceChannel = voiceChannelOption as VoiceBasedChannel;
  const textChannel = textChannelOption as TextChannel;
  const tagsRaw = interaction.options.getString("tags") || undefined;

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "Please select a valid voice channel.",
      ephemeral: true,
    });
    return;
  }

  if (!textChannel || textChannel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "Please select a valid text channel.",
      ephemeral: true,
    });
    return;
  }

  // Check if bot has permissions in both channels
  const botMember = interaction.guild!.members.cache.get(
    interaction.client.user!.id,
  );

  if (!botMember) {
    await interaction.reply({
      content: "Bot not found in guild.",
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
      content: `I can't enable auto-recording yet. ${permissionCheck.errorMessage}`,
      ephemeral: true,
    });
    return;
  }

  try {
    await saveAutoRecordSetting({
      guildId: interaction.guild!.id,
      channelId: voiceChannel.id,
      textChannelId: textChannel.id,
      enabled: true,
      recordAll: false,
      createdBy: interaction.user.id,
      tags: parseTags(tagsRaw),
    });

    const embed = new EmbedBuilder()
      .setTitle("Auto-Record Enabled")
      .setDescription(
        `Auto-recording has been enabled for **${voiceChannel.name}**`,
      )
      .addFields(
        { name: "Voice Channel", value: voiceChannel.name, inline: true },
        { name: "Text Channel", value: textChannel.name, inline: true },
      )
      .setColor(0x00ae86)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Error enabling auto-record:", error);
    await interaction.reply({
      content: "Failed to enable auto-recording. Please try again later.",
      ephemeral: true,
    });
  }
}

async function handleDisableAutoRecord(
  interaction: ChatInputCommandInteraction,
) {
  const voiceChannelOption = interaction.options.getChannel("voice-channel");

  if (!voiceChannelOption) {
    await interaction.reply({
      content: "Voice channel is required.",
      ephemeral: true,
    });
    return;
  }

  const voiceChannel = voiceChannelOption as VoiceBasedChannel;

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "Please select a valid voice channel.",
      ephemeral: true,
    });
    return;
  }

  try {
    const existing = await getAutoRecordSettingByChannel(
      interaction.guild!.id,
      voiceChannel.id,
    );

    if (!existing) {
      await interaction.reply({
        content: `Auto-recording is not enabled for **${voiceChannel.name}**.`,
        ephemeral: true,
      });
      return;
    }

    await removeAutoRecordSetting(interaction.guild!.id, voiceChannel.id);

    const embed = new EmbedBuilder()
      .setTitle("Auto-Record Disabled")
      .setDescription(
        `Auto-recording has been disabled for **${voiceChannel.name}**`,
      )
      .setColor(0xff0000)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Error disabling auto-record:", error);
    await interaction.reply({
      content: "Failed to disable auto-recording. Please try again later.",
      ephemeral: true,
    });
  }
}

async function handleDisableAutoRecordAll(
  interaction: ChatInputCommandInteraction,
) {
  try {
    const existing = await getAutoRecordSettingByChannel(
      interaction.guild!.id,
      "ALL",
    );

    if (!existing) {
      await interaction.reply({
        content: "Auto-recording for all channels is not enabled.",
        ephemeral: true,
      });
      return;
    }

    await removeAutoRecordSetting(interaction.guild!.id, "ALL");

    const embed = new EmbedBuilder()
      .setTitle("Auto-Record Disabled for All Channels")
      .setDescription("Auto-recording has been disabled for all voice channels")
      .setColor(0xff0000)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Error disabling auto-record for all:", error);
    await interaction.reply({
      content:
        "Failed to disable auto-recording for all channels. Please try again later.",
      ephemeral: true,
    });
  }
}

async function handleEnableAllAutoRecord(
  interaction: ChatInputCommandInteraction,
) {
  const textChannelOption = interaction.options.getChannel("text-channel");
  const tagsRaw = interaction.options.getString("tags") || undefined;

  if (!textChannelOption) {
    await interaction.reply({
      content: "Text channel is required.",
      ephemeral: true,
    });
    return;
  }

  const textChannel = textChannelOption as TextChannel;

  if (!textChannel || textChannel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "Please select a valid text channel.",
      ephemeral: true,
    });
    return;
  }

  // Check if bot has permissions in text channel
  const botMember = interaction.guild!.members.cache.get(
    interaction.client.user!.id,
  );

  if (!botMember) {
    await interaction.reply({
      content: "Bot not found in guild.",
      ephemeral: true,
    });
    return;
  }

  const missingTextPermissions = getMissingMeetingTextChannelPermissions(
    textChannel,
    botMember,
  );
  if (missingTextPermissions.length > 0) {
    await interaction.reply({
      content: `I can't enable auto-recording for all channels yet. I am missing ${formatMissingPermissions(missingTextPermissions)} in **${textChannel.name}**.`,
      ephemeral: true,
    });
    return;
  }

  try {
    // Check if there's already a record-all setting
    const existing = await getAutoRecordSettingByChannel(
      interaction.guild!.id,
      "ALL",
    );
    if (existing) {
      await interaction.reply({
        content:
          "Auto-recording for all channels is already enabled. Use `/autorecord disable-all` to disable it first.",
        ephemeral: true,
      });
      return;
    }

    await saveAutoRecordSetting({
      guildId: interaction.guild!.id,
      channelId: "ALL",
      textChannelId: textChannel.id,
      enabled: true,
      recordAll: true,
      createdBy: interaction.user.id,
      tags: parseTags(tagsRaw),
    });

    const embed = new EmbedBuilder()
      .setTitle("Auto-Record Enabled for All Channels")
      .setDescription(
        `Auto-recording has been enabled for **all voice channels**`,
      )
      .addFields({
        name: "Text Channel",
        value: textChannel.name,
        inline: true,
      })
      .setColor(0x00ae86)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Error enabling auto-record for all:", error);
    await interaction.reply({
      content:
        "Failed to enable auto-recording for all channels. Please try again later.",
      ephemeral: true,
    });
  }
}

async function handleListAutoRecord(interaction: ChatInputCommandInteraction) {
  try {
    const settings = await listAutoRecordSettings(interaction.guild!.id);
    const defaultNotesChannelId = await resolveConfigString(
      { guildId: interaction.guild!.id },
      CONFIG_KEYS.notes.channelId,
      { trim: true, logLabel: "Failed to resolve server config defaults" },
    );

    if (settings.length === 0) {
      await interaction.reply({
        content: "No auto-record settings configured for this server.",
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Auto-Record Settings")
      .setDescription(
        `Found ${settings.length} auto-record configuration(s) for this server`,
      )
      .setColor(0x3498db)
      .setTimestamp();

    for (const setting of settings) {
      const resolvedTextChannelId =
        setting.textChannelId ?? defaultNotesChannelId;
      if (setting.recordAll) {
        const textChannel = interaction.guild!.channels.cache.get(
          resolvedTextChannelId ?? "",
        );
        embed.addFields({
          name: "📹 All Voice Channels",
          value: `Text Channel: ${textChannel ? textChannel.name : "Default notes channel"}\nStatus: ${setting.enabled ? "✅ Enabled" : "❌ Disabled"}`,
          inline: false,
        });
      } else {
        const voiceChannel = interaction.guild!.channels.cache.get(
          setting.channelId,
        );
        const textChannel = interaction.guild!.channels.cache.get(
          resolvedTextChannelId ?? "",
        );
        embed.addFields({
          name: `🎤 ${voiceChannel ? voiceChannel.name : "Unknown Channel"}`,
          value: `Text Channel: ${textChannel ? textChannel.name : "Default notes channel"}\nStatus: ${setting.enabled ? "✅ Enabled" : "❌ Disabled"}`,
          inline: true,
        });
      }
    }

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Error listing auto-record settings:", error);
    await interaction.reply({
      content: "Failed to list auto-record settings. Please try again later.",
      ephemeral: true,
    });
  }
}
