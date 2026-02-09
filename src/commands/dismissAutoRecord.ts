import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
  type Client,
  type UserContextMenuCommandInteraction,
} from "discord.js";
import { CONFIG_KEYS } from "../config/keys";
import { getMeeting } from "../meetings";
import { resolveConfigEnum } from "../services/unifiedConfigService";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";
import { handleEndMeetingOther } from "./endMeeting";

export const DISMISS_AUTORECORD_COMMAND_NAME = "Stop recording";

const DISMISS_POLICY_OPTIONS = [
  "solo_or_admin",
  "trigger_or_admin",
  "anyone_in_channel",
] as const;

type DismissPolicy = (typeof DISMISS_POLICY_OPTIONS)[number];

const DEFAULT_DISMISS_POLICY: DismissPolicy = "solo_or_admin";

export const dismissAutoRecordCommand = new ContextMenuCommandBuilder()
  .setName(DISMISS_AUTORECORD_COMMAND_NAME)
  .setType(ApplicationCommandType.User)
  .setDMPermission(false);

function hasAdminPermissions(interaction: UserContextMenuCommandInteraction) {
  return (
    interaction.memberPermissions?.any([
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageMessages,
    ]) ?? false
  );
}

export async function handleDismissAutoRecord(
  client: Client,
  interaction: UserContextMenuCommandInteraction,
) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const botUserId = client.user?.id;
  if (!botUserId) {
    await interaction.reply({
      content: "Bot is not ready yet.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.targetUser.id !== botUserId) {
    await interaction.reply({
      content: `Use this command on <@${botUserId}>.`,
      ephemeral: true,
    });
    return;
  }

  const meeting = getMeeting(interaction.guildId);
  if (!meeting) {
    await interaction.reply({
      content: "No active recording to stop right now.",
      ephemeral: true,
    });
    return;
  }

  if (!meeting.isAutoRecording) {
    await interaction.reply({
      content: "This command only applies to auto-recorded meetings.",
      ephemeral: true,
    });
    return;
  }

  if (meeting.finishing) {
    await interaction.reply({
      content: "This meeting is already ending.",
      ephemeral: true,
    });
    return;
  }

  const invokerId = interaction.user.id;
  const invokerMember = meeting.voiceChannel.members.get(invokerId);
  if (!invokerMember) {
    await interaction.reply({
      content: "Join the meeting voice channel to stop recording.",
      ephemeral: true,
    });
    return;
  }

  const admin = hasAdminPermissions(interaction);
  const nonBotMembers = meeting.voiceChannel.members.filter(
    (member) => !member.user.bot,
  );
  const soloNonBot = nonBotMembers.size === 1 && nonBotMembers.has(invokerId);

  const policy =
    (await resolveConfigEnum(
      { guildId: interaction.guildId },
      CONFIG_KEYS.autorecord.dismissPolicy,
      DISMISS_POLICY_OPTIONS,
      DEFAULT_DISMISS_POLICY,
      { logLabel: "Failed to resolve auto-record dismiss policy" },
    )) ?? DEFAULT_DISMISS_POLICY;

  const allowedByPolicy =
    policy === "anyone_in_channel" ||
    (policy === "trigger_or_admin" &&
      meeting.startTriggeredByUserId === invokerId);

  if (!(admin || soloNonBot || allowedByPolicy)) {
    const policyHint =
      policy === "trigger_or_admin"
        ? "Ask an admin, or the user who triggered auto-record."
        : "Ask an admin.";
    await interaction.reply({
      content: `You do not have permission to stop this auto-record. ${policyHint}`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  meeting.endReason = MEETING_END_REASONS.DISMISSED;
  meeting.endTriggeredByUserId = invokerId;
  meeting.cancelled = true;
  meeting.cancellationReason = `Stopped by <@${invokerId}>`;

  await handleEndMeetingOther(client, meeting);
  await interaction.editReply("Stopped recording.");
}
