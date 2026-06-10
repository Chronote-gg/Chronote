import { ChatInputCommandInteraction, Client } from "discord.js";
import { handleEndMeetingOther } from "./endMeeting";
import { endTtsOnlySession, getMeeting } from "../meetings";
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

export async function handleLeaveCommand(
  client: Client,
  interaction: ChatInputCommandInteraction,
) {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const meeting = getMeeting(interaction.guildId);
  if (!meeting || meeting.finished) {
    await interaction.reply({
      content: "Chronote is not in an active voice session here.",
      ephemeral: true,
    });
    return;
  }

  await hydrateMemberCache(interaction);
  if (!hasLeavePermission(interaction)) {
    await interaction.reply({
      content:
        "You do not have permission to make Chronote leave this session.",
      ephemeral: true,
    });
    return;
  }

  if (meeting.sessionMode === "tts_only") {
    await endTtsOnlySession(meeting);
    await interaction.reply({
      content: "Chronote left the TTS-only voice session.",
      ephemeral: true,
    });
    return;
  }

  const confirmed = interaction.options.getBoolean("confirm") ?? false;
  if (!confirmed) {
    await interaction.reply({
      content:
        "Chronote is recording this meeting. Run `/leave confirm:true` to end the meeting and disconnect Chronote.",
      ephemeral: true,
    });
    return;
  }

  meeting.endReason = MEETING_END_REASONS.LEAVE_COMMAND;
  meeting.endTriggeredByUserId = interaction.user.id;
  await interaction.deferReply({ ephemeral: true });
  await handleEndMeetingOther(client, meeting);
  await interaction.editReply(
    "Meeting ended. Chronote left the voice channel.",
  );
}
