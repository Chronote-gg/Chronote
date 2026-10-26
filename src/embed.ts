import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
  runMeetingNoticeMutation,
} from "./services/meetingProcessingLifetime";
import { recordNotesAcknowledgement } from "./observability/meetingNotesLatency";
import {
  beginRecordingDelivery,
  acknowledgeRecordingDeliveryMessage,
  finishRecordingDeliveryMutations,
} from "./services/recordingDeliveryService";
import {
  DiscordAPIError,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
} from "discord.js";
import { MeetingData } from "./types/meeting-data";
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
import { claimSummaryUpgrade } from "./services/summaryUpgradeService";
import { captureEvent } from "./services/analyticsService";
import { resolveMeetingActorId } from "./utils/meetingLifecycle";
import {
  buildSummaryUpgradeBody,
  SUMMARY_UPGRADE,
} from "./utils/summaryUpgrade";

const PROCESSING_COLOR = 0x3498db;
const SUMMARY_COLOR = 0x00ae86;
const DEFAULT_TITLE = "Meeting Summary";
const MAX_FIELD_VALUE = 1024;

type MeetingMessagePayload = {
  embeds: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
};

function buildMeetingHistoryKey(meeting: MeetingData): string {
  return `${meeting.voiceChannel.id}#${meeting.startTime.toISOString()}`;
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

function buildMeetingFields(meeting: MeetingData) {
  const attendanceList = Array.from(meeting.attendance).join("\n");
  const startLabel = formatTimestamp(meeting.startTime);
  const actualEnd =
    meeting.recordingCaptureState?.kind === "interrupted"
      ? meeting.recordingCaptureState.endedAt
        ? new Date(meeting.recordingCaptureState.endedAt)
        : undefined
      : meeting.endTime;
  const endLabel = actualEnd ? formatTimestamp(actualEnd) : "Unknown";
  const durationLabel = actualEnd
    ? formatDurationMinutes(meeting.startTime, actualEnd)
    : meeting.recordingCaptureState?.kind === "interrupted"
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
    { name: "Voice Channel", value: meeting.voiceChannel.name },
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

function resolveMeetingTitle(meeting: MeetingData): string {
  const name = meeting.meetingName?.trim();
  if (name) return name;
  const label = meeting.summaryLabel?.trim();
  if (label) return label;
  return DEFAULT_TITLE;
}

function buildProcessingEmbed(meeting: MeetingData): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${resolveMeetingTitle(meeting)} (processing)`)
    .setColor(PROCESSING_COLOR)
    .setDescription(
      "Processing transcript and meeting notes. This can take a few minutes.",
    )
    .addFields(buildMeetingFields(meeting))
    .setTimestamp();
}

function buildSummaryEmbed(meeting: MeetingData): EmbedBuilder {
  const summary =
    meeting.summarySentence?.trim() ?? meeting.summaryLabel?.trim();
  return new EmbedBuilder()
    .setTitle(resolveMeetingTitle(meeting))
    .setColor(SUMMARY_COLOR)
    .setDescription(
      withMeetingCaptureNotice(
        summary && summary.length > 0 ? summary : "Summary unavailable.",
        {
          capture: meeting.recordingCaptureState,
          processing: meeting.processing,
          notes: meeting.notesText,
        },
      ),
    )
    .addFields(buildMeetingFields(meeting))
    .setTimestamp();
}

function buildNotesEmbeds(meeting: MeetingData): EmbedBuilder[] {
  if (!meeting.generateNotes) return [];
  const notes = meeting.notesText?.trim();
  const notesBody = notes || (meeting.processing ? "" : "Notes unavailable.");
  return buildMeetingNotesEmbeds({
    notesBody,
    color: SUMMARY_COLOR,
    processing: meeting.processing,
    capture: meeting.recordingCaptureState,
  }).map((embed) => embed.setTimestamp());
}

function buildMeetingPortalUrl(meeting: MeetingData): string {
  const base = config.frontend.siteUrl.replace(/\/$/, "");
  return buildPortalMeetingUrl({
    baseUrl: base,
    guildId: meeting.guildId,
    meetingId: buildMeetingHistoryKey(meeting),
    fullScreen: true,
  });
}

function buildResultRow(
  meeting: MeetingData,
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
  meeting: MeetingData,
  portalUrl: string,
  upgradeUrl?: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const channelIdTimestamp = buildMeetingHistoryKey(meeting);
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
export function updateMeetingMessage(
  meeting: MeetingData,
  payload: MeetingMessagePayload,
  phase: Exclude<DeliveryPhase, "notes">,
  finalization = false,
): Promise<{ message?: Message; delivery: DeliveryResult }> {
  const ownedNotice = Boolean(meeting.finalization) && !finalization;
  const run = () =>
    deliverMeetingMessage(meeting, payload, phase, finalization, ownedNotice);
  return ownedNotice ? runMeetingProcessingEffect(meeting, run) : run();
}
function missingMeetingMessage(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    error.code === 10008 &&
    error.status === 404
  );
}
function rejectedMeetingMessage(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    error.status >= 400 &&
    error.status < 500
  );
}
function fallbackDiagnostics(
  error: unknown,
  finalization: boolean,
): Pick<
  Extract<DeliveryResult, { outcome: "sent_fallback" }>,
  "errors" | "recoveredMissingMessage"
> {
  return finalization && missingMeetingMessage(error)
    ? { errors: [], recoveredMissingMessage: { code: 10008, status: 404 } }
    : { errors: [deliveryError(error)] };
}
async function deliverMeetingMessage(
  meeting: MeetingData,
  payload: MeetingMessagePayload,
  phase: Exclude<DeliveryPhase, "notes">,
  finalization: boolean,
  ownedNotice: boolean,
): Promise<{ message?: Message; delivery: DeliveryResult }> {
  const signal =
    finalization || ownedNotice
      ? getMeetingProcessingSignal(meeting)
      : undefined;
  signal?.throwIfAborted();
  const channel = meeting.textChannel;
  let fallback: ReturnType<typeof fallbackDiagnostics> = { errors: [] };
  if (meeting.startMessageId) {
    try {
      const message = await channel.messages.fetch(meeting.startMessageId);
      signal?.throwIfAborted();
      if (ownedNotice)
        await runMeetingNoticeMutation(
          meeting,
          () => message.edit(payload),
          rejectedMeetingMessage,
        );
      else await message.edit(payload);
      if (finalization)
        await acknowledgeRecordingDeliveryMessage(
          meeting,
          "summary",
          message.id,
        );
      return {
        message,
        delivery: recordDelivery(meeting, phase, {
          outcome: "edited_existing",
          intended: 1,
          sent: 1,
          errors: [],
        }),
      };
    } catch (error) {
      signal?.throwIfAborted();
      if ((finalization || ownedNotice) && !missingMeetingMessage(error))
        throw error;
      fallback = fallbackDiagnostics(error, finalization);
    }
  }

  try {
    signal?.throwIfAborted();
    const message = ownedNotice
      ? await runMeetingNoticeMutation(
          meeting,
          () => channel.send(payload),
          rejectedMeetingMessage,
        )
      : await channel.send(payload);
    if (finalization)
      await acknowledgeRecordingDeliveryMessage(meeting, "summary", message.id);
    meeting.startMessageId = message.id;
    return {
      message,
      delivery: recordDelivery(meeting, phase, {
        outcome: "sent_fallback",
        intended: 1,
        sent: 1,
        ...fallback,
      }),
    };
  } catch (error) {
    if (finalization || ownedNotice) throw error;
    return {
      delivery: recordDelivery(meeting, phase, {
        outcome: "failed",
        intended: 1,
        sent: 0,
        errors: [...fallback.errors, deliveryError(error)],
      }),
    };
  }
}

export async function updateMeetingProcessingMessage(
  meeting: MeetingData,
): Promise<DeliveryResult> {
  const { delivery } = await updateMeetingMessage(
    meeting,
    {
      embeds: [buildProcessingEmbed(meeting)],
      components: [],
    },
    "processing",
  );
  return delivery;
}

export function updateMeetingSummaryMessage(
  meeting: MeetingData,
  options?: { finalization: boolean },
) {
  return options?.finalization
    ? runMeetingProcessingEffect(meeting, async () => {
        await beginRecordingDelivery(meeting);
        const result = await deliverMeetingSummary(meeting, true);
        finishRecordingDeliveryMutations(meeting);
        return result;
      })
    : deliverMeetingSummary(meeting, false);
}
async function deliverMeetingSummary(
  meeting: MeetingData,
  finalization: boolean,
): Promise<{ summary: DeliveryResult; notes: DeliveryResult }> {
  const portalUrl = buildMeetingPortalUrl(meeting);
  const upgrade = await claimSummaryUpgrade(meeting);
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
  const summaryPayload: MeetingMessagePayload = {
    embeds: [summaryEmbed],
    components: buildSummaryComponents(meeting, portalUrl, upgrade?.url),
  };
  const { message: summaryMessage, delivery: summary } =
    await updateMeetingMessage(
      meeting,
      summaryPayload,
      "summary",
      finalization,
    );
  if (summaryMessage) {
    meeting.summaryMessageId = summaryMessage.id;
  }
  if (
    upgrade &&
    (summary.outcome === "edited_existing" ||
      summary.outcome === "sent_fallback")
  ) {
    captureEvent("upgrade_offer_delivered", {
      userId: resolveMeetingActorId(meeting),
      guildId: meeting.guildId,
      properties: { surface: "discord_summary", event_version: 1 },
    });
  }

  const noteEmbeds = buildNotesEmbeds(meeting);
  if (upgradeField) noteEmbeds.at(-1)?.addFields(upgradeField);
  const notes = await sendMeetingNotes(
    meeting,
    noteEmbeds,
    notesUpgradeUrl,
    finalization,
  );
  return { summary, notes };
}

async function acknowledgeMeetingNotes(
  meeting: MeetingData,
  messageId: string,
  complete: boolean,
): Promise<void> {
  const timing = meeting.notesText?.trim()
    ? recordNotesAcknowledgement(meeting.notesDeliveryTiming, {
        acknowledgedAt: new Date().toISOString(),
        complete,
        path: "live",
      })
    : undefined;
  await acknowledgeRecordingDeliveryMessage(
    meeting,
    "notes",
    messageId,
    timing,
  );
}

async function sendMeetingNotes(
  meeting: MeetingData,
  noteEmbeds: EmbedBuilder[],
  upgradeUrl: URL | undefined,
  finalization: boolean,
): Promise<DeliveryResult> {
  const noteEmbedBatches = batchMeetingNotesEmbeds(noteEmbeds);
  const noteMessages: Message[] = [];
  const errors: DeliveryResult["errors"] = [];
  for (const embeds of noteEmbedBatches) {
    const payload: MeetingMessagePayload = {
      embeds,
      components:
        embeds === noteEmbedBatches.at(-1)
          ? [
              buildResultRow(
                meeting,
                buildMeetingPortalUrl(meeting),
                upgradeUrl?.toString(),
              ),
            ]
          : [],
    };
    try {
      if (finalization) getMeetingProcessingSignal(meeting).throwIfAborted();
      const message = await meeting.textChannel.send(payload);
      if (finalization) {
        await acknowledgeMeetingNotes(
          meeting,
          message.id,
          embeds === noteEmbedBatches.at(-1),
        );
      }
      noteMessages.push(message);
      if (upgradeUrl && embeds === noteEmbedBatches.at(-1)) {
        captureEvent("upgrade_offer_delivered", {
          userId: resolveMeetingActorId(meeting),
          guildId: meeting.guildId,
          properties: { surface: "discord_notes", event_version: 1 },
        });
      }
    } catch (error) {
      if (finalization) throw error;
      errors.push(deliveryError(error));
    }
  }

  if (noteMessages.length) {
    meeting.notesMessageIds = noteMessages.map((note) => note.id);
    meeting.notesChannelId = meeting.textChannel.id;
  } else {
    meeting.notesMessageIds = undefined;
    meeting.notesChannelId = undefined;
  }
  const intended = noteEmbedBatches.length;
  const sent = noteMessages.length;
  return recordDelivery(meeting, "notes", {
    outcome:
      intended === 0
        ? "not_applicable"
        : sent === intended
          ? "complete"
          : sent > 0
            ? "partial"
            : "failed",
    intended,
    sent,
    errors,
  });
}
