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
import type { MeetingData } from "../types/meeting-data";
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

type StopRecordingPermissionDecision =
  | { allowed: true }
  | { allowed: false; hint: string };

function resolveStopRecordingPermission(options: {
  policy: DismissPolicy;
  invokerId: string;
  admin: boolean;
  soloNonBot: boolean;
  startTriggeredByUserId?: MeetingData["startTriggeredByUserId"];
}): StopRecordingPermissionDecision {
  if (options.admin) return { allowed: true };

  const allowedByPolicy =
    options.policy === "anyone_in_channel" ||
    (options.policy === "trigger_or_admin" &&
      options.startTriggeredByUserId === options.invokerId) ||
    (options.policy === "solo_or_admin" && options.soloNonBot);

  if (allowedByPolicy) return { allowed: true };

  const hint =
    options.policy === "trigger_or_admin"
      ? "Ask an admin, or the user who triggered auto-record."
      : options.policy === "solo_or_admin"
        ? "Ask an admin, or be the only non-bot member in the voice channel."
        : "Ask an admin.";

  return { allowed: false, hint };
}

type DismissAutoRecordContext = {
  meeting: MeetingData;
  invokerId: string;
  policy: DismissPolicy;
  admin: boolean;
  soloNonBot: boolean;
};

type DismissAutoRecordCheckResult =
  | { ok: true; context: DismissAutoRecordContext }
  | { ok: false; message: string };

async function resolveDismissAutoRecordContext(
  client: Client,
  interaction: UserContextMenuCommandInteraction,
): Promise<DismissAutoRecordCheckResult> {
  if (!interaction.inGuild()) {
    return { ok: false, message: "This command can only be used in a server." };
  }

  const botUserId = client.user?.id;
  if (!botUserId) {
    return { ok: false, message: "Bot is not ready yet." };
  }

  if (interaction.targetUser.id !== botUserId) {
    return { ok: false, message: `Use this command on <@${botUserId}>.` };
  }

  const meeting = getMeeting(interaction.guildId);
  if (!meeting) {
    return { ok: false, message: "No active recording to stop right now." };
  }

  if (!meeting.isAutoRecording) {
    return {
      ok: false,
      message: "This command only applies to auto-recorded meetings.",
    };
  }

  if (meeting.finishing) {
    return { ok: false, message: "This meeting is already ending." };
  }

  const invokerId = interaction.user.id;
  const invokerMember = meeting.voiceChannel.members.get(invokerId);
  if (!invokerMember) {
    return {
      ok: false,
      message: "Join the meeting voice channel to stop recording.",
    };
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

  return {
    ok: true,
    context: {
      meeting,
      invokerId,
      policy,
      admin,
      soloNonBot,
    },
  };
}

export async function handleDismissAutoRecord(
  client: Client,
  interaction: UserContextMenuCommandInteraction,
) {
  const contextResult = await resolveDismissAutoRecordContext(
    client,
    interaction,
  );
  if (!contextResult.ok) {
    await interaction.reply({
      content: contextResult.message,
      ephemeral: true,
    });
    return;
  }

  const { meeting, invokerId, policy, admin, soloNonBot } =
    contextResult.context;

  const permissionDecision = resolveStopRecordingPermission({
    policy,
    invokerId,
    admin,
    soloNonBot,
    startTriggeredByUserId: meeting.startTriggeredByUserId,
  });

  if (!permissionDecision.allowed) {
    await interaction.reply({
      content: `You do not have permission to stop this auto-record. ${permissionDecision.hint}`,
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
