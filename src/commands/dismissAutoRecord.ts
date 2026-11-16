import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
  type Client,
  type Collection,
  type GuildMember,
  type UserContextMenuCommandInteraction,
} from "discord.js";
import { CONFIG_KEYS } from "../config/keys";
import { getMeeting } from "../meetings";
import { resolveConfigEnum } from "../services/unifiedConfigService";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";
import type { MeetingData } from "../types/meeting-data";
import { canUserEndMeeting } from "../utils/meetingPermissions";
import { dismissalCancellationReason } from "../utils/meetingLifecycle";
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
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageGuild,
    ]) ?? false
  );
}

type StopRecordingPermissionDecision =
  { allowed: true } | { allowed: false; hint: string };

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
};

type DismissAutoRecordCheckResult =
  | { ok: true; context: DismissAutoRecordContext }
  | { ok: false; message: string };

/** Why this member may not stop an auto-recording under the server's dismiss policy, or undefined when they may. */
export async function autoRecordStopRefusal(
  interaction: UserContextMenuCommandInteraction,
  session: {
    guildId: string;
    startTriggeredByUserId?: string;
    voiceMembers: Collection<string, GuildMember>;
  },
): Promise<string | undefined> {
  const invokerId = interaction.user.id;
  if (!session.voiceMembers.has(invokerId))
    return "Join the meeting voice channel to stop recording.";
  const nonBotMembers = session.voiceMembers.filter(
    (member) => !member.user.bot,
  );
  const policy =
    (await resolveConfigEnum(
      { guildId: session.guildId },
      CONFIG_KEYS.autorecord.dismissPolicy,
      DISMISS_POLICY_OPTIONS,
      DEFAULT_DISMISS_POLICY,
      { logLabel: "Failed to resolve auto-record dismiss policy" },
    )) ?? DEFAULT_DISMISS_POLICY;
  const decision = resolveStopRecordingPermission({
    policy,
    invokerId,
    admin: hasAdminPermissions(interaction),
    soloNonBot: nonBotMembers.size === 1 && nonBotMembers.has(invokerId),
    startTriggeredByUserId: session.startTriggeredByUserId,
  });
  return decision.allowed
    ? undefined
    : `You do not have permission to stop this auto-record. ${decision.hint}`;
}

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

  const invokerId = interaction.user.id;
  if (!meeting.isAutoRecording)
    return canUserEndMeeting(meeting, invokerId)
      ? { ok: true, context: { meeting, invokerId } }
      : {
          ok: false,
          message: "You do not have permission to end this meeting.",
        };

  const refusal = await autoRecordStopRefusal(interaction, {
    guildId: interaction.guildId,
    startTriggeredByUserId: meeting.startTriggeredByUserId,
    voiceMembers: meeting.voiceChannel.members,
  });
  return refusal
    ? { ok: false, message: refusal }
    : { ok: true, context: { meeting, invokerId } };
}

export async function handleDismissAutoRecord(
  client: Client,
  interaction: UserContextMenuCommandInteraction,
  signal?: AbortSignal,
) {
  const contextResult = await resolveDismissAutoRecordContext(
    client,
    interaction,
  );
  if (!contextResult.ok) {
    signal?.throwIfAborted();
    await interaction.reply({
      content: contextResult.message,
      ephemeral: true,
    });
    return;
  }

  const { meeting, invokerId } = contextResult.context;

  signal?.throwIfAborted();
  await interaction.deferReply({ ephemeral: true });
  if (meeting.finishing) {
    signal?.throwIfAborted();
    await interaction.editReply("This meeting is already ending.");
    return;
  }

  meeting.endReason = meeting.isAutoRecording
    ? MEETING_END_REASONS.DISMISSED
    : MEETING_END_REASONS.BUTTON;
  meeting.endTriggeredByUserId = invokerId;

  if (meeting.isAutoRecording) {
    meeting.cancelled = true;
    meeting.cancellationReason = dismissalCancellationReason(invokerId);
  }

  await handleEndMeetingOther(client, meeting);
  await interaction.editReply(
    meeting.isAutoRecording ? "Stopped recording." : "Ended meeting.",
  );
}
