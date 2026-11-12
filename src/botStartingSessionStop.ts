import {
  Collection,
  type GuildMember,
  type RepliableInteraction,
} from "discord.js";
import { replyRecordingEnded } from "./botInteractionScope";
import { autoRecordStopRefusal } from "./commands/dismissAutoRecord";
import { LEAVE_CONFIRM_PROMPT } from "./commands/leave";
import { getActiveMeetingLease } from "./db";
import { LIFECYCLE } from "./services/lifecycleTiming";
import { requestMeetingEndViaLease } from "./services/meetingLease";
import type { ActiveMeetingLease } from "./types/db";
import {
  MEETING_END_REASONS,
  type MeetingEndReason,
} from "./types/meetingLifecycle";
import { canMemberEndLease } from "./utils/meetingPermissions";

function stopReason(
  interaction: RepliableInteraction,
  lease: ActiveMeetingLease,
): MeetingEndReason {
  if (interaction.isChatInputCommand())
    return MEETING_END_REASONS.LEAVE_COMMAND;
  if (interaction.isUserContextMenuCommand() && lease.isAutoRecording)
    return MEETING_END_REASONS.DISMISSED;
  return MEETING_END_REASONS.BUTTON;
}

/** The same rules the live handlers apply, read from the lease because the meeting does not exist yet. */
async function stopRefusal(
  interaction: RepliableInteraction,
  lease: ActiveMeetingLease,
): Promise<string | undefined> {
  if (
    interaction.isUserContextMenuCommand() &&
    lease.isAutoRecording &&
    interaction.guild
  ) {
    const channel = interaction.guild.channels.cache.get(lease.voiceChannelId);
    const voiceMembers = channel?.isVoiceBased()
      ? channel.members
      : new Collection<string, GuildMember>();
    return autoRecordStopRefusal(interaction, {
      guildId: lease.guildId,
      startTriggeredByUserId: lease.startTriggeredByUserId,
      voiceMembers,
    });
  }
  const member: GuildMember | null | undefined =
    await interaction.guild?.members
      .fetch(interaction.user.id)
      .catch(() => null);
  if (
    !canMemberEndLease(
      member,
      interaction.user.id,
      lease.startTriggeredByUserId,
    )
  )
    return "You do not have permission to end this meeting.";
  if (
    interaction.isChatInputCommand() &&
    lease.sessionMode !== "tts_only" &&
    !(interaction.options.getBoolean("confirm") ?? false)
  )
    return LEAVE_CONFIRM_PROMPT;
  return undefined;
}

/**
 * A stop pressed while this process is still building the session has no
 * meeting to end yet. It is recorded on the lease, and the start applies it
 * the moment the meeting exists, as it does for a portal stop. A dismissed
 * auto-recording therefore ends with reason `dismissed` but without the
 * live handler's cancellation flag; it has recorded almost nothing by then.
 */
export async function stopStartingSession(
  interaction: RepliableInteraction,
  guildId: string,
  meetingId: string,
): Promise<void> {
  // A start publishes its End button only after the meeting is live, so a
  // press reaching here is on an earlier meeting's message.
  if (interaction.isButton()) {
    await replyRecordingEnded(interaction);
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const lease = await getActiveMeetingLease(
    guildId,
    AbortSignal.timeout(LIFECYCLE.leaseHeartbeatMs),
  );
  if (!lease || lease.meetingId !== meetingId) {
    await interaction.editReply(
      "Chronote is not in an active voice session here.",
    );
    return;
  }
  const refusal = await stopRefusal(interaction, lease);
  if (refusal) {
    await interaction.editReply(refusal);
    return;
  }
  const queued = await requestMeetingEndViaLease(
    guildId,
    meetingId,
    interaction.user.id,
    stopReason(interaction, lease),
  );
  await interaction.editReply(
    queued
      ? "Chronote is still joining. The meeting will end as soon as it has started."
      : "The meeting could not be stopped. Please try again.",
  );
}
