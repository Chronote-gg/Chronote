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

async function replyEphemeral(
  interaction: UserContextMenuCommandInteraction,
  content: string,
) {
  await interaction.reply({ content, ephemeral: true });
}

function getAutoRecordPolicyHint(policy: DismissPolicy) {
  if (policy === "trigger_or_admin") {
    return "Ask an admin, or the user who triggered auto-record.";
  }
  return "Ask an admin.";
}

function isAllowedByDismissPolicy(
  policy: DismissPolicy,
  meeting: NonNullable<ReturnType<typeof getMeeting>>,
  invokerId: string,
) {
  if (policy === "anyone_in_channel") {
    return true;
  }

  if (policy === "trigger_or_admin") {
    return meeting.startTriggeredByUserId === invokerId;
  }

  return false;
}

function canDismissAutoRecord(
  interaction: UserContextMenuCommandInteraction,
  meeting: NonNullable<ReturnType<typeof getMeeting>>,
  invokerId: string,
  policy: DismissPolicy,
) {
  const isAdmin = hasAdminPermissions(interaction);
  if (isAdmin) {
    return true;
  }

  const nonBotMembers = meeting.voiceChannel.members.filter(
    (member) => !member.user.bot,
  );
  const isSoloNonBot = nonBotMembers.size === 1 && nonBotMembers.has(invokerId);
  if (isSoloNonBot) {
    return true;
  }

  return isAllowedByDismissPolicy(policy, meeting, invokerId);
}

export async function handleDismissAutoRecord(
  client: Client,
  interaction: UserContextMenuCommandInteraction,
) {
  if (!interaction.inGuild()) {
    await replyEphemeral(
      interaction,
      "This command can only be used in a server.",
    );
    return;
  }

  const botUserId = client.user?.id;
  if (!botUserId) {
    await replyEphemeral(interaction, "Bot is not ready yet.");
    return;
  }

  if (interaction.targetUser.id !== botUserId) {
    await replyEphemeral(interaction, `Use this command on <@${botUserId}>.`);
    return;
  }

  const meeting = getMeeting(interaction.guildId);
  if (!meeting) {
    await replyEphemeral(interaction, "No active recording to stop right now.");
    return;
  }

  if (!meeting.isAutoRecording) {
    await replyEphemeral(
      interaction,
      "This command only applies to auto-recorded meetings.",
    );
    return;
  }

  if (meeting.finishing) {
    await replyEphemeral(interaction, "This meeting is already ending.");
    return;
  }

  const invokerId = interaction.user.id;
  const invokerMember = meeting.voiceChannel.members.get(invokerId);
  if (!invokerMember) {
    await replyEphemeral(
      interaction,
      "Join the meeting voice channel to stop recording.",
    );
    return;
  }

  const policy =
    (await resolveConfigEnum(
      { guildId: interaction.guildId },
      CONFIG_KEYS.autorecord.dismissPolicy,
      DISMISS_POLICY_OPTIONS,
      DEFAULT_DISMISS_POLICY,
      { logLabel: "Failed to resolve auto-record dismiss policy" },
    )) ?? DEFAULT_DISMISS_POLICY;

  if (!canDismissAutoRecord(interaction, meeting, invokerId, policy)) {
    const policyHint = getAutoRecordPolicyHint(policy);
    await replyEphemeral(
      interaction,
      `You do not have permission to stop this auto-record. ${policyHint}`,
    );
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
