import { ChatInputCommandInteraction, Client } from "discord.js";
import { handleEndMeetingOther } from "./endMeeting";
import { getMeeting } from "../meetings";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";
import { canUserEndMeeting } from "../utils/meetingPermissions";

async function hydrateMemberCache(interaction: ChatInputCommandInteraction) {
  await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
}

function hasLeavePermission(interaction: ChatInputCommandInteraction) {
  const meeting = interaction.guildId ? getMeeting(interaction.guildId) : null;
  if (!meeting) return false;
  return canUserEndMeeting(meeting, interaction.user.id);
}

export const LEAVE_CONFIRM_PROMPT =
  "Chronote is recording this meeting. Run `/leave confirm:true` to end the meeting and disconnect Chronote.";

function abortIfRequested(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export async function handleLeaveCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
  signal?: AbortSignal,
) {
  if (!interaction.guildId || !interaction.guild) {
    abortIfRequested(signal);
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const meeting = getMeeting(interaction.guildId);
  if (!meeting || meeting.finished) {
    abortIfRequested(signal);
    await interaction.reply({
      content: "Chronote is not in an active voice session here.",
      ephemeral: true,
    });
    return;
  }

  abortIfRequested(signal);
  await interaction.deferReply({ ephemeral: true });
  abortIfRequested(signal);

  await hydrateMemberCache(interaction);
  if (!hasLeavePermission(interaction)) {
    abortIfRequested(signal);
    await interaction.editReply(
      "You do not have permission to make Chronote leave this session.",
    );
    return;
  }

  if (meeting.sessionMode === "tts_only") {
    meeting.endReason = MEETING_END_REASONS.LEAVE_COMMAND;
    meeting.endTriggeredByUserId = interaction.user.id;
    await handleEndMeetingOther(client, meeting);
    await interaction.editReply("Chronote left the TTS-only voice session.");
    return;
  }

  const confirmed = interaction.options.getBoolean("confirm") ?? false;
  if (!confirmed) {
    abortIfRequested(signal);
    await interaction.editReply(LEAVE_CONFIRM_PROMPT);
    return;
  }

  meeting.endReason = MEETING_END_REASONS.LEAVE_COMMAND;
  meeting.endTriggeredByUserId = interaction.user.id;
  await handleEndMeetingOther(client, meeting);
  await interaction.editReply(
    "Meeting ended. Chronote left the voice channel.",
  );
}
