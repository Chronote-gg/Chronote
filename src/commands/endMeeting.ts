import { ButtonInteraction, Client, EmbedBuilder } from "discord.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildMixedAudio,
  cleanupSpeakerTracks,
  closeOutputFile,
  compileTranscriptions,
  startProcessingSnippet,
  waitForAudioOnlyFinishProcessing,
  waitForFinishProcessing,
} from "../audio";
import {
  updateMeetingProcessingMessage,
  updateMeetingSummaryMessage,
} from "../embed";
import { deleteIfExists } from "../util";
import { MeetingData } from "../types/meeting-data";
import { saveMeetingHistoryToDatabase } from "./saveMeetingHistory";
import { updateMeetingStatusService } from "../services/meetingHistoryService";
import { renderChatEntryLine } from "../utils/chatLog";
import { uploadMeetingArtifacts } from "../services/uploadService";
import { buildUpgradeTextOnly } from "../utils/upgradePrompt";
import { getGuildLimits } from "../services/subscriptionService";
import { stopThinkingCueLoop } from "../audio/soundCues";
import { canUserEndMeeting } from "../utils/meetingPermissions";
import {
  getNextAvailableAt,
  getRollingUsageForGuild,
  getRollingWindowMs,
} from "../services/meetingUsageService";
import {
  withMeetingEndTrace,
  withMeetingEndStep,
  type MeetingEndStepOptions,
} from "../observability/meetingTrace";
import { evaluateAutoRecordCancellation } from "../services/autoRecordCancellationService";
import { autoRecordJoinSuppressionService } from "../services/autoRecordJoinSuppressionService";
import { meetingsCancelled } from "../metrics";
import { describeAutoRecordRule } from "../utils/meetingLifecycle";
import { deleteMeeting, getMeeting, hasMeeting } from "../meetings";
import { MEETING_END_REASONS, MEETING_STATUS } from "../types/meetingLifecycle";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "../services/meetingNotesService";
import { captionMeetingImages } from "../services/imageCaptionService";
import {
  cleanupMeetingTempDir,
  ensureMeetingTempDir,
} from "../services/tempFileService";
import { releaseMeetingLeaseForMeeting } from "../services/activeMeetingLeaseService";
import { runTranscriptionFinalPass } from "../services/transcriptionFinalPassService";

type EndMeetingFlowOptions = {
  client: Client;
  meeting: MeetingData;
};

async function runMeetingEndStep<T>(
  meeting: MeetingData,
  name: string,
  run: () => Promise<T>,
  options: MeetingEndStepOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  const result = await withMeetingEndStep(meeting, name, run, options);
  const durationMs = Date.now() - startedAt;
  console.log(`Meeting end step completed: ${name} durationMs=${durationMs}`);
  return result;
}

function shouldReleaseLeaseDuringErrorCleanup(meeting: MeetingData): boolean {
  return !meeting.finishing && !meeting.finished;
}

export async function handleEndMeetingButton(
  client: Client,
  interaction: ButtonInteraction,
) {
  const guildId = interaction.guildId!;

  const meeting = getMeeting(guildId);

  try {
    if (!meeting) {
      await interaction.reply("No active meeting to end in this channel.");
      return;
    }

    if (!canUserEndMeeting(meeting, interaction.user.id)) {
      await interaction.reply(
        "You do not have permission to end this meeting.",
      );
      return;
    }

    if (meeting.finishing) {
      await interaction.reply("Meeting is already finishing!");
      return;
    }

    if (meeting.finished) {
      await interaction.reply("Meeting is already finished!");
      return;
    }

    meeting.endReason = MEETING_END_REASONS.BUTTON;
    meeting.endTriggeredByUserId = interaction.user.id;

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }

    await withMeetingEndTrace(meeting, async () => {
      await runEndMeetingFlow({ client, meeting });
    });
  } catch (error) {
    console.error("Error during meeting end:", error);
    if (meeting && hasMeeting(meeting.guildId)) {
      if (shouldReleaseLeaseDuringErrorCleanup(meeting)) {
        try {
          await releaseMeetingLeaseForMeeting(meeting);
        } catch (releaseError) {
          console.error(
            "Failed to release meeting lease during error cleanup",
            {
              guildId: meeting.guildId,
              meetingId: meeting.meetingId,
              error: releaseError,
            },
          );
        }
      }
      meeting.setFinished();
      meeting.finished = true;
      deleteMeeting(meeting.guildId);
    }
    if (meeting) {
      await cleanupMeetingTempDir(meeting);
    }
  }
}

export async function handleEndMeetingOther(
  client: Client,
  meeting: MeetingData,
) {
  try {
    await withMeetingEndTrace(meeting, async () => {
      await runEndMeetingFlow({ client, meeting });
    });
  } catch (error) {
    console.error("Error during meeting end:", error);
    if (meeting && hasMeeting(meeting.guildId)) {
      if (shouldReleaseLeaseDuringErrorCleanup(meeting)) {
        try {
          await releaseMeetingLeaseForMeeting(meeting);
        } catch (releaseError) {
          console.error(
            "Failed to release meeting lease during error cleanup",
            {
              guildId: meeting.guildId,
              meetingId: meeting.meetingId,
              error: releaseError,
            },
          );
        }
      }
      meeting.setFinished();
      meeting.finished = true;
      deleteMeeting(meeting.guildId);
    }
    await cleanupMeetingTempDir(meeting);
  }
}

async function runEndMeetingFlow(options: EndMeetingFlowOptions) {
  const { client, meeting } = options;
  if (meeting.finishing || meeting.finished) {
    return;
  }
  if (meeting.timeoutTimer) {
    clearTimeout(meeting.timeoutTimer);
    meeting.timeoutTimer = undefined;
  }

  meeting.finishing = true;
  meeting.endTime = new Date();
  if (!meeting.endReason) {
    meeting.endReason = MEETING_END_REASONS.UNKNOWN;
  }
  const initialEndReason = meeting.endReason;
  await markMeetingProcessing(meeting);
  stopThinkingCueLoop(meeting);
  meeting.ttsQueue?.stopAndClear();

  await runMeetingEndStep(meeting, "update-processing-message", () =>
    updateMeetingProcessingMessage(meeting),
  );

  const meetingTempDir = await ensureMeetingTempDir(meeting);
  try {
    const chatLogFilePath = path.join(meetingTempDir, "chat.txt");
    writeFileSync(
      chatLogFilePath,
      meeting.chatLog
        .map((e) => renderChatEntryLine(e, { includeAttachmentUrls: true }))
        .join("\n"),
    );

    // checking if the current snippet exists should only matter when there was no audio recorded at all
    meeting.audioData.currentSnippets.forEach((snippet) => {
      startProcessingSnippet(meeting, snippet.userId);
    });

    maybeSuppressAutoRecordRejoin(meeting, initialEndReason);

    if (meeting.connection) {
      meeting.connection.disconnect();
      meeting.connection.destroy();
    }

    await runMeetingEndStep(meeting, "wait-audio-only", () =>
      waitForAudioOnlyFinishProcessing(meeting),
    );

    await runMeetingEndStep(meeting, "close-output-file", () =>
      closeOutputFile(meeting),
    );

    if (meeting.cancelled) {
      await runMeetingEndStep(meeting, "auto-record-cancel-flow", () =>
        handleAutoRecordCancellation(meeting, chatLogFilePath),
      );
      await runMeetingEndStep(meeting, "cleanup-speaker-tracks", () =>
        cleanupSpeakerTracks(meeting),
      );
      return;
    }

    const cancellationDecision = await runMeetingEndStep(
      meeting,
      "auto-record-cancellation",
      () => evaluateAutoRecordCancellation(meeting),
      {
        metadata: {
          audioFiles: meeting.audioData.audioFiles.length,
        },
      },
    );
    if (cancellationDecision.cancel) {
      meeting.cancelled = true;
      meeting.cancellationReason = cancellationDecision.reason;
      meeting.endReason = MEETING_END_REASONS.AUTO_CANCELLED;
      await runMeetingEndStep(meeting, "auto-record-cancel-flow", () =>
        handleAutoRecordCancellation(meeting, chatLogFilePath),
      );
      await runMeetingEndStep(meeting, "cleanup-speaker-tracks", () =>
        cleanupSpeakerTracks(meeting),
      );
      return;
    }

    const combinedAudioFile = meeting.audioData.outputFileName!;
    const mixedAudioFile = await runMeetingEndStep(
      meeting,
      "build-mixed-audio",
      () => buildMixedAudio(meeting),
      {
        metadata: {
          speakerTrackCount: meeting.audioData.speakerTracks?.size ?? 0,
        },
      },
    );
    const outputAudioFile = mixedAudioFile ?? combinedAudioFile;

    let transcriptForUpload: string | undefined;
    const transcriptionsReady = meeting.audioData.audioFiles.every(
      (file) => !file.processing,
    );

    if (meeting.transcribeMeeting) {
      if (!transcriptionsReady) {
        const pending = meeting.audioData.audioFiles.filter(
          (file) => file.processing,
        ).length;
        console.log(
          `Waiting for transcriptions to finish: pending=${pending} meetingId=${meeting.meetingId}`,
        );
        await runMeetingEndStep(
          meeting,
          "wait-transcriptions",
          () => waitForFinishProcessing(meeting),
          {
            metadata: {
              pending,
            },
          },
        );
      }

      const finalPassResult = await runMeetingEndStep(
        meeting,
        "transcription-final-pass",
        () =>
          runTranscriptionFinalPass(meeting, {
            audioFilePath: outputAudioFile,
          }),
      );
      console.log("Transcription final pass completed.", {
        meetingId: meeting.meetingId,
        ...finalPassResult,
      });

      const transcriptions = await runMeetingEndStep(
        meeting,
        "compile-transcriptions",
        () => compileTranscriptions(client, meeting),
      );
      meeting.finalTranscript = transcriptions;

      if (meeting.generateNotes) {
        await runMeetingEndStep(
          meeting,
          "caption-images",
          () => captionMeetingImages(meeting),
          {
            metadata: {
              chatEntries: meeting.chatLog.length,
            },
          },
        );
        const notes = await runMeetingEndStep(meeting, "generate-notes", () =>
          ensureMeetingNotes(meeting),
        );
        await runMeetingEndStep(meeting, "generate-summary", () =>
          ensureMeetingSummaries(meeting, notes),
        );
      }

      transcriptForUpload = await runMeetingEndStep(
        meeting,
        "compile-transcriptions-upload",
        () =>
          compileTranscriptions(client, meeting, {
            includeCues: true,
          }),
      );
    }

    // Upload artifacts after transcript generation (or audio/chat only)
    await runMeetingEndStep(meeting, "upload-artifacts", () =>
      uploadMeetingArtifacts(meeting, {
        audioFilePath: outputAudioFile,
        chatFilePath: chatLogFilePath,
        transcriptText: transcriptForUpload,
      }),
    );

    await runMeetingEndStep(meeting, "update-summary-message", () =>
      updateMeetingSummaryMessage(meeting),
    );

    deleteIfExists(chatLogFilePath);
    deleteIfExists(outputAudioFile);
    if (outputAudioFile !== combinedAudioFile) {
      // Only delete the combined file when a separate mixed file was used.
      deleteIfExists(combinedAudioFile);
    }
    await runMeetingEndStep(meeting, "cleanup-speaker-tracks", () =>
      cleanupSpeakerTracks(meeting),
    );

    // Save meeting history to database before cleanup
    await runMeetingEndStep(meeting, "save-meeting-history", () =>
      saveMeetingHistoryToDatabase(meeting),
    );
    await runMeetingEndStep(meeting, "minutes-limit-notice", () =>
      maybeSendMinutesLimitNotice(meeting),
    );

    meeting.setFinished();
    meeting.finished = true;
    deleteMeeting(meeting.guildId);
  } finally {
    try {
      const released = await releaseMeetingLeaseForMeeting(meeting);
      if (!released) {
        console.warn("Failed to release active meeting lease ownership", {
          guildId: meeting.guildId,
          meetingId: meeting.meetingId,
        });
      }
    } catch (error) {
      console.error("Error releasing active meeting lease", {
        guildId: meeting.guildId,
        meetingId: meeting.meetingId,
        error,
      });
    }
    await cleanupMeetingTempDir(meeting);
  }
}

function maybeSuppressAutoRecordRejoin(
  meeting: MeetingData,
  endReason: MeetingData["endReason"],
) {
  if (!meeting.isAutoRecording) return;
  if (
    endReason !== MEETING_END_REASONS.BUTTON &&
    endReason !== MEETING_END_REASONS.WEB_UI &&
    endReason !== MEETING_END_REASONS.LIVE_VOICE &&
    endReason !== MEETING_END_REASONS.DISMISSED
  ) {
    return;
  }
  const members = meeting.voiceChannel?.members;
  if (!members) return;
  const nonBotMemberIds = members
    .filter((member) => !member.user.bot)
    .map((member) => member.id);
  autoRecordJoinSuppressionService.suppressUntilEmpty({
    guildId: meeting.guildId,
    channelId: meeting.voiceChannel.id,
    nonBotMemberIds,
    reason: "explicit_end",
  });
}

async function handleAutoRecordCancellation(
  meeting: MeetingData,
  chatLogFilePath: string,
) {
  meetingsCancelled.inc();
  await updateAutoRecordCancelledMessage(meeting);
  await deleteTrackedMessages(meeting);
  deleteIfExists(chatLogFilePath);
  if (meeting.audioData.outputFileName) {
    deleteIfExists(meeting.audioData.outputFileName);
  }
  await saveMeetingHistoryToDatabase(meeting);
  meeting.setFinished();
  meeting.finished = true;
  deleteMeeting(meeting.guildId);
}

async function deleteTrackedMessages(meeting: MeetingData) {
  const messageIds = meeting.messagesToDelete ?? [];
  if (messageIds.length === 0) return;
  await Promise.all(
    messageIds.map(async (messageId) => {
      try {
        const message = await meeting.textChannel.messages.fetch(messageId);
        await message.delete();
      } catch (error) {
        console.warn("Failed to delete auto-record notice message", error);
      }
    }),
  );
}

async function updateAutoRecordCancelledMessage(meeting: MeetingData) {
  const triggerLabel = meeting.startTriggeredByUserId
    ? `<@${meeting.startTriggeredByUserId}>`
    : "Unknown";
  const ruleLabel = describeAutoRecordRule(
    meeting.autoRecordRule,
    meeting.voiceChannel.name,
  );
  const reason =
    meeting.cancellationReason ??
    "Not enough content detected to keep this meeting.";
  const trimmedReason =
    reason.length > 700 ? `${reason.slice(0, 697)}...` : reason;

  const embed = new EmbedBuilder()
    .setTitle("Auto-Recording Cancelled")
    .setDescription("Auto-recording started and was cancelled.")
    .addFields(
      { name: "Triggered by", value: triggerLabel },
      { name: "Rule", value: ruleLabel },
      { name: "Reason", value: trimmedReason },
    )
    .setColor(0x6c757d)
    .setTimestamp();

  if (meeting.startMessageId) {
    try {
      const message = await meeting.textChannel.messages.fetch(
        meeting.startMessageId,
      );
      await message.edit({ embeds: [embed], components: [] });
      return;
    } catch (error) {
      console.warn("Failed to update auto-record start message", error);
    }
  }

  try {
    await meeting.textChannel.send({ embeds: [embed] });
  } catch (error) {
    console.warn("Failed to send auto-record cancellation message", error);
  }
}

async function markMeetingProcessing(meeting: MeetingData) {
  if (!meeting.transcribeMeeting) return;
  try {
    await updateMeetingStatusService({
      guildId: meeting.guildId,
      channelId_timestamp: `${meeting.voiceChannel.id}#${meeting.startTime.toISOString()}`,
      status: MEETING_STATUS.PROCESSING,
    });
  } catch (error) {
    console.warn("Failed to mark meeting as processing", error);
  }
}

async function maybeSendMinutesLimitNotice(meeting: MeetingData) {
  const { limits } = await getGuildLimits(meeting.guildId);
  if (!limits.maxMeetingMinutesRolling) return;

  const usage = await getRollingUsageForGuild(meeting.guildId);
  const limitSeconds = limits.maxMeetingMinutesRolling * 60;
  const remainingSeconds = limitSeconds - usage.usedSeconds;
  const remainingMinutes = Math.max(0, Math.ceil(remainingSeconds / 60));
  const thresholdMinutes = Math.max(
    60,
    Math.ceil(limits.maxMeetingMinutesRolling * 0.2),
  );

  const windowStartMs = Date.parse(usage.windowStartIso);
  const nextAvailableAtIso = getNextAvailableAt(
    usage.meetings,
    windowStartMs,
    getRollingWindowMs(),
    limitSeconds,
  );
  if (usage.usedSeconds >= limitSeconds) {
    const nextLabel = nextAvailableAtIso
      ? `You can record again after <t:${Math.floor(
          Date.parse(nextAvailableAtIso) / 1000,
        )}:R>.`
      : "You can record again once older meetings roll out of the window.";
    await meeting.textChannel.send(
      buildUpgradeTextOnly(
        `You've reached the weekly minutes limit for this plan. ${nextLabel}`,
      ),
    );
    return;
  }

  if (remainingMinutes <= thresholdMinutes) {
    await meeting.textChannel.send(
      buildUpgradeTextOnly(
        `Heads up: about ${remainingMinutes} minute(s) left in the weekly free-tier window.`,
      ),
    );
  }
}
