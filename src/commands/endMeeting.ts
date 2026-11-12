import type { ButtonInteraction, Client } from "discord.js";
import { updateMeetingProcessingMessage } from "../embed";
import { getMeeting } from "../meetings";
import { autoRecordJoinSuppressionService } from "../services/autoRecordJoinSuppressionService";
import { deferInteractionUpdate } from "../services/interactionResponseService";
import { closeMeeting } from "../services/meetingClose";
import { saveReplacementStartMessageId } from "../services/meetingStartMessage";
import type { MeetingData } from "../types/meeting-data";
import { MEETING_END_REASONS } from "../types/meetingLifecycle";
import { canUserEndMeeting } from "../utils/meetingPermissions";

export type EndMeetingFlowOptions = {
  meeting: MeetingData;
  /** The portal and the control queue confirm the suppression before they stop. */
  suppressionPersisted?: boolean;
};

const EXPLICIT_STOP_REASONS: ReadonlyArray<MeetingData["endReason"]> = [
  MEETING_END_REASONS.BUTTON,
  MEETING_END_REASONS.WEB_UI,
  MEETING_END_REASONS.MCP,
  MEETING_END_REASONS.LIVE_VOICE,
  MEETING_END_REASONS.LEAVE_COMMAND,
  MEETING_END_REASONS.DISMISSED,
];

export async function handleEndMeetingButton(
  client: Client,
  interaction: ButtonInteraction,
) {
  const meeting = getMeeting(interaction.guildId!);
  if (!meeting) {
    await interaction.reply("No active meeting to end in this channel.");
    return;
  }
  if (
    !meeting.startMessageId ||
    interaction.message.id !== meeting.startMessageId
  ) {
    await interaction.reply("This meeting control is no longer active.");
    return;
  }
  if (!canUserEndMeeting(meeting, interaction.user.id)) {
    await interaction.reply("You do not have permission to end this meeting.");
    return;
  }
  if (meeting.finished) {
    await interaction.reply("Meeting is already finished!");
    return;
  }
  if (!interaction.deferred && !interaction.replied)
    await deferInteractionUpdate(interaction);
  if (meeting.finishing) {
    await interaction.followUp({
      content: "Meeting is already finishing!",
      ephemeral: true,
    });
    return;
  }
  meeting.endReason = MEETING_END_REASONS.BUTTON;
  meeting.endTriggeredByUserId = interaction.user.id;
  await runEndMeetingFlow({ meeting });
}

/** Ends a meeting for a reason already set on it (timeout, empty channel, remote request, leave, dismissal). */
export async function handleEndMeetingOther(
  client: Client,
  meeting: MeetingData,
) {
  await runEndMeetingFlow({ meeting });
}

/**
 * What a stop does for the user before close: the processing state on the
 * recording message and, for an explicit stop of an auto-recording, the
 * suppression that keeps the bot from rejoining. Both run beside close so
 * neither can hold the server. Same close promise for every caller.
 */
export async function runEndMeetingFlow(
  options: EndMeetingFlowOptions,
): Promise<void> {
  const { meeting, suppressionPersisted = false } = options;
  const cause = {
    endReason: meeting.endReason ?? MEETING_END_REASONS.UNKNOWN,
    endTriggeredByUserId: meeting.endTriggeredByUserId,
  };
  if (meeting.sessionMode === "tts_only") return closeMeeting(meeting, cause);
  // Kept on the meeting so the local finish delivers only after it settles.
  // A replacement's id reaches the row first, because delivery, on this worker
  // or another, edits the message the row names.
  if (!meeting.finishing)
    meeting.processingMessageShown = updateMeetingProcessingMessage(
      meeting,
    ).then(
      async (result) => {
        if (result.outcome === "sent_fallback" && meeting.startMessageId)
          await saveReplacementStartMessageId(meeting, meeting.startMessageId);
      },
      (error: unknown) =>
        console.warn("Meeting processing message was not shown", {
          meetingId: meeting.meetingId,
          error,
        }),
    );
  const suppression = suppressionPersisted
    ? undefined
    : persistExplicitMeetingStop(meeting, cause.endReason).catch(
        (error: unknown) =>
          console.warn("Auto-record suppression was not saved", {
            meetingId: meeting.meetingId,
            error,
          }),
      );
  await Promise.all([closeMeeting(meeting, cause), suppression]);
}

/** An explicit stop of an auto-recording keeps the bot out of the channel until it empties. */
export async function persistExplicitMeetingStop(
  meeting: MeetingData,
  endReason: MeetingData["endReason"],
) {
  if (!meeting.isAutoRecording || !EXPLICIT_STOP_REASONS.includes(endReason))
    return;
  await persistAutoRecordSuppression(meeting, "explicit_end");
}

export async function persistAutoRecordSuppression(
  meeting: MeetingData,
  reason: "explicit_end" | "forced_disconnect",
): Promise<boolean> {
  if (!meeting.isAutoRecording) return false;
  const members = meeting.voiceChannel?.members;
  if (!members) return false;
  const nonBotMemberIds = members
    .filter((member) => !member.user.bot)
    .map((member) => member.id);
  return autoRecordJoinSuppressionService.suppressUntilEmpty({
    guildId: meeting.guildId,
    channelId: meeting.voiceChannel.id,
    nonBotMemberIds,
    reason,
    meetingId: meeting.meetingId,
  });
}
