import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { MeetingData } from "./types/meeting-data";
import type { MeetingHistory } from "./types/db";
import type { MeetingProcessingOutcome } from "./types/meetingProcessing";
import type { RecordingCaptureState } from "./types/meetingLifecycle";
import type { CaptureCoverageSummary } from "./types/recordingCheckpoint";
import { formatUserMention } from "./utils/participants";
import { withMeetingCaptureNotice } from "./utils/meetingCaptureNotice";
import { config } from "./services/configService";
import { buildPortalMeetingUrl } from "./utils/portalLinks";
import { buildSummaryFeedbackButtonIds } from "./commands/summaryFeedback";
import { MEETING_RENAME_PREFIX } from "./commands/meetingName";
import { deliveryError, recordDelivery } from "./observability/meetingDelivery";
import type { DeliveryPhase, DeliveryResult } from "./types/meetingDelivery";
import {
  batchMeetingNotesEmbeds,
  buildMeetingNotesEmbeds,
} from "./utils/meetingNotes";
import { describeAutoRecordRule } from "./utils/meetingLifecycle";
import { MEETING_END_REASONS } from "./types/meetingLifecycle";
import {
  buildSummaryUpgradeBody,
  SUMMARY_UPGRADE,
} from "./utils/summaryUpgrade";

const PROCESSING_COLOR = 0x3498db;
const SUMMARY_COLOR = 0x00ae86;
const DEFAULT_TITLE = "Meeting Summary";
const MAX_FIELD_VALUE = 1024;
const MS_PER_SECOND = 1000;
const CANCELLED_COLOR = 0x6c757d;
const CANCELLED_REASON_MAX_LENGTH = 700;
const DEFAULT_CANCELLED_REASON =
  "Not enough content detected to keep this meeting.";

export type MeetingMessagePayload = {
  embeds: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
};

export type SummaryUpgradeOffer = { url: string; recordedSeconds: number };

/** Plain data every meeting embed renders from, whether the source is live or saved. */
export type MeetingPresentation = {
  guildId: string;
  historyKey: string;
  startTime: Date;
  /** Actual end of capture; undefined when unknown or not yet ended. */
  endTime?: Date;
  /** Embed timestamp; undefined stamps the posting time. */
  timestamp?: Date;
  attendees: string[];
  voiceChannel: string;
  tags?: string[];
  meetingName?: string;
  summaryLabel?: string;
  summarySentence?: string;
  notes?: string;
  generateNotes: boolean;
  processing?: MeetingProcessingOutcome;
  capture?: RecordingCaptureState;
  /** Saved audio an interrupted meeting's notice reports; a live meeting has none yet. */
  captureCoverage?: CaptureCoverageSummary;
};

function captureEnd(capture: RecordingCaptureState | undefined, end?: Date) {
  if (capture?.kind !== "interrupted") return end;
  return capture.endedAt ? new Date(capture.endedAt) : undefined;
}

export function presentationFromMeeting(
  meeting: MeetingData,
): MeetingPresentation {
  const capture = meeting.recordingCaptureState;
  return {
    guildId: meeting.guildId,
    historyKey: `${meeting.voiceChannel.id}#${meeting.startTime.toISOString()}`,
    startTime: meeting.startTime,
    endTime: captureEnd(capture, meeting.endTime),
    attendees: Array.from(meeting.attendance),
    voiceChannel: meeting.voiceChannel.name,
    tags: meeting.tags,
    meetingName: meeting.meetingName,
    summaryLabel: meeting.summaryLabel,
    summarySentence: meeting.summarySentence,
    notes: meeting.notesText,
    generateNotes: meeting.generateNotes,
    processing: meeting.processing,
    capture,
  };
}

/**
 * A saved row has no channel object, so the voice channel renders as a mention,
 * and attendance comes from the participant snapshot rather than live presence.
 * The embed timestamp is the meeting start, which delivery reads back as its marker.
 */
export function presentationFromHistory(
  history: MeetingHistory,
): MeetingPresentation {
  const startTime = new Date(history.timestamp);
  return {
    guildId: history.guildId,
    historyKey: history.channelId_timestamp,
    startTime,
    endTime: captureEnd(
      history.capture,
      new Date(startTime.getTime() + history.duration * MS_PER_SECOND),
    ),
    timestamp: startTime,
    attendees: history.participants.map((participant) =>
      formatUserMention(participant.id),
    ),
    voiceChannel: `<#${history.channelId}>`,
    tags: history.tags,
    meetingName: history.meetingName,
    summaryLabel: history.summaryLabel,
    summarySentence: history.summarySentence,
    notes: history.notes,
    generateNotes: history.generateNotes,
    processing: history.processing,
    capture: history.capture,
    captureCoverage: history.captureCoverage,
  };
}

/** What the auto-record cancellation message shows, from a live meeting or a saved row. */
export type AutoRecordCancellation = Pick<
  MeetingHistory,
  | "startTriggeredByUserId"
  | "autoRecordRule"
  | "cancellationReason"
  | "endReason"
> & { voiceChannelName?: string };

/** The embed that replaces the start message when an auto-recording is cancelled or stopped. */
export function buildAutoRecordCancelledEmbed(
  cancellation: AutoRecordCancellation,
): EmbedBuilder {
  const reason = cancellation.cancellationReason ?? DEFAULT_CANCELLED_REASON;
  const trimmedReason =
    reason.length > CANCELLED_REASON_MAX_LENGTH
      ? `${reason.slice(0, CANCELLED_REASON_MAX_LENGTH - 3)}...`
      : reason;
  const dismissed = cancellation.endReason === MEETING_END_REASONS.DISMISSED;
  return new EmbedBuilder()
    .setTitle(dismissed ? "Auto-Recording Stopped" : "Auto-Recording Cancelled")
    .setDescription(
      dismissed
        ? "Auto-recording was stopped before the meeting finished."
        : "Auto-recording started and was cancelled.",
    )
    .addFields(
      {
        name: "Triggered by",
        value: cancellation.startTriggeredByUserId
          ? `<@${cancellation.startTriggeredByUserId}>`
          : "Unknown",
      },
      {
        name: "Rule",
        value: describeAutoRecordRule(
          cancellation.autoRecordRule,
          cancellation.voiceChannelName,
        ),
      },
      { name: "Reason", value: trimmedReason },
    )
    .setColor(CANCELLED_COLOR)
    .setTimestamp();
}

function formatTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}

function formatDurationMinutes(start: Date, end: Date): string {
  const minutes = Math.max(
    0,
    Math.floor((end.getTime() - start.getTime()) / 60000),
  );
  return `${minutes} minutes`;
}

function truncateFieldValue(value: string, max = MAX_FIELD_VALUE): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function buildMeetingFields(meeting: MeetingPresentation) {
  const attendanceList = meeting.attendees.join("\n");
  const startLabel = formatTimestamp(meeting.startTime);
  const actualEnd = meeting.endTime;
  const endLabel = actualEnd ? formatTimestamp(actualEnd) : "Unknown";
  const durationLabel = actualEnd
    ? formatDurationMinutes(meeting.startTime, actualEnd)
    : meeting.capture?.kind === "interrupted"
      ? "Unknown"
      : formatDurationMinutes(meeting.startTime, new Date());

  const fields = [
    { name: "Start Time", value: startLabel, inline: true },
    { name: "End Time", value: endLabel, inline: true },
    { name: "Duration", value: durationLabel, inline: true },
    {
      name: "Attendees",
      value: truncateFieldValue(attendanceList || "No members recorded."),
    },
    { name: "Voice Channel", value: meeting.voiceChannel },
  ];

  if (meeting.tags && meeting.tags.length) {
    fields.push({
      name: "Tags",
      value: truncateFieldValue(meeting.tags.join(", ")),
      inline: true,
    });
  }

  return fields;
}

function resolveMeetingTitle(meeting: MeetingPresentation): string {
  const name = meeting.meetingName?.trim();
  if (name) return name;
  const label = meeting.summaryLabel?.trim();
  if (label) return label;
  return DEFAULT_TITLE;
}

function buildProcessingEmbed(meeting: MeetingPresentation): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${resolveMeetingTitle(meeting)} (processing)`)
    .setColor(PROCESSING_COLOR)
    .setDescription(
      "Processing transcript and meeting notes. This can take a few minutes.",
    )
    .addFields(buildMeetingFields(meeting))
    .setTimestamp();
}

function buildSummaryEmbed(meeting: MeetingPresentation): EmbedBuilder {
  const summary =
    meeting.summarySentence?.trim() ?? meeting.summaryLabel?.trim();
  return new EmbedBuilder()
    .setTitle(resolveMeetingTitle(meeting))
    .setColor(SUMMARY_COLOR)
    .setDescription(
      withMeetingCaptureNotice(
        summary && summary.length > 0 ? summary : "Summary unavailable.",
        {
          capture: meeting.capture,
          captureCoverage: meeting.captureCoverage,
          processing: meeting.processing,
          notes: meeting.notes,
        },
      ),
    )
    .addFields(buildMeetingFields(meeting))
    .setTimestamp(meeting.timestamp);
}

function buildNotesEmbeds(meeting: MeetingPresentation): EmbedBuilder[] {
  if (!meeting.generateNotes) return [];
  const notes = meeting.notes?.trim();
  const notesBody = notes || (meeting.processing ? "" : "Notes unavailable.");
  return buildMeetingNotesEmbeds({
    notesBody,
    color: SUMMARY_COLOR,
    processing: meeting.processing,
    capture: meeting.capture,
    captureCoverage: meeting.captureCoverage,
  }).map((embed) => embed.setTimestamp(meeting.timestamp));
}

function buildMeetingPortalUrl(meeting: MeetingPresentation): string {
  const base = config.frontend.siteUrl.replace(/\/$/, "");
  return buildPortalMeetingUrl({
    baseUrl: base,
    guildId: meeting.guildId,
    meetingId: meeting.historyKey,
    fullScreen: true,
  });
}

function buildResultRow(
  meeting: MeetingPresentation,
  portalUrl: string,
  upgradeUrl?: string,
): ActionRowBuilder<ButtonBuilder> {
  const base = config.frontend.siteUrl.replace(/\/$/, "");
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open meeting")
      .setEmoji("\u{1F680}")
      .setStyle(ButtonStyle.Link)
      .setURL(portalUrl),
    new ButtonBuilder()
      .setLabel("Optional setup")
      .setStyle(ButtonStyle.Link)
      .setURL(
        `${base}/join?serverId=${encodeURIComponent(meeting.guildId)}#optional-setup`,
      ),
  );
  if (upgradeUrl) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel(SUMMARY_UPGRADE.button)
        .setStyle(ButtonStyle.Link)
        .setURL(upgradeUrl),
    );
  }
  return row;
}

function buildSummaryComponents(
  meeting: MeetingPresentation,
  portalUrl: string,
  upgradeUrl?: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const channelIdTimestamp = meeting.historyKey;
  const encodedKey = Buffer.from(channelIdTimestamp).toString("base64");
  const feedbackIds = buildSummaryFeedbackButtonIds(channelIdTimestamp);
  const actionButtons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(feedbackIds.up)
      .setLabel("Helpful")
      .setEmoji("\u{1F44D}")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(feedbackIds.down)
      .setLabel("Needs work")
      .setEmoji("\u{1F914}")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`notes_correction:${meeting.guildId}:${encodedKey}`)
      .setLabel("Suggest correction")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${MEETING_RENAME_PREFIX}:${meeting.guildId}:${encodedKey}`)
      .setLabel("Rename meeting")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`edit_tags_history:${meeting.guildId}:${encodedKey}`)
      .setLabel("Edit tags")
      .setStyle(ButtonStyle.Secondary),
  ];
  const rows = [buildResultRow(meeting, portalUrl, upgradeUrl)];
  if (actionButtons.length > 0) {
    const firstRow = actionButtons.slice(0, 3);
    const secondRow = actionButtons.slice(3);
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...firstRow));
    if (secondRow.length) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(...secondRow),
      );
    }
  }
  return rows;
}
async function updateMeetingMessage(
  meeting: MeetingData,
  payload: MeetingMessagePayload,
  phase: Exclude<DeliveryPhase, "notes">,
): Promise<DeliveryResult> {
  const channel = meeting.textChannel;
  const errors: DeliveryResult["errors"] = [];
  if (meeting.startMessageId) {
    try {
      const message = await channel.messages.fetch(meeting.startMessageId);
      await message.edit(payload);
      return recordDelivery(meeting, phase, {
        outcome: "edited_existing",
        intended: 1,
        sent: 1,
        errors: [],
      });
    } catch (error) {
      errors.push(deliveryError(error));
    }
  }

  try {
    const message = await channel.send(payload);
    meeting.startMessageId = message.id;
    return recordDelivery(meeting, phase, {
      outcome: "sent_fallback",
      intended: 1,
      sent: 1,
      errors,
    });
  } catch (error) {
    return recordDelivery(meeting, phase, {
      outcome: "failed",
      intended: 1,
      sent: 0,
      errors: [...errors, deliveryError(error)],
    });
  }
}

export async function updateMeetingProcessingMessage(
  meeting: MeetingData,
): Promise<DeliveryResult> {
  return updateMeetingMessage(
    meeting,
    {
      embeds: [buildProcessingEmbed(presentationFromMeeting(meeting))],
      components: [],
    },
    "processing",
  );
}

/** The summary and notes messages for a finished meeting; the one renderer for every delivery path. */
export function buildMeetingResultMessages(
  meeting: MeetingPresentation,
  upgrade?: SummaryUpgradeOffer,
): { summary: MeetingMessagePayload; notes: MeetingMessagePayload[] } {
  const portalUrl = buildMeetingPortalUrl(meeting);
  const notesUpgradeUrl = upgrade ? new URL(upgrade.url) : undefined;
  notesUpgradeUrl?.searchParams.set("source", "discord_notes");
  const upgradeField = upgrade
    ? {
        name: SUMMARY_UPGRADE.heading,
        value: buildSummaryUpgradeBody(upgrade.recordedSeconds),
      }
    : undefined;
  const summaryEmbed = buildSummaryEmbed(meeting);
  if (upgradeField) summaryEmbed.addFields(upgradeField);
  const noteEmbeds = buildNotesEmbeds(meeting);
  if (upgradeField) noteEmbeds.at(-1)?.addFields(upgradeField);
  const batches = batchMeetingNotesEmbeds(noteEmbeds);
  return {
    summary: {
      embeds: [summaryEmbed],
      components: buildSummaryComponents(meeting, portalUrl, upgrade?.url),
    },
    notes: batches.map((embeds, index) => ({
      embeds,
      components:
        index === batches.length - 1
          ? [buildResultRow(meeting, portalUrl, notesUpgradeUrl?.toString())]
          : [],
    })),
  };
}
