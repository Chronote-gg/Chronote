import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
} from "discord.js";
import { MeetingData } from "./types/meeting-data";
import { config } from "./services/configService";
import { buildPortalMeetingUrl } from "./utils/portalLinks";
import { buildSummaryFeedbackButtonIds } from "./commands/summaryFeedback";
import { MEETING_RENAME_PREFIX } from "./commands/meetingName";
import { deliveryError, recordDelivery } from "./observability/meetingDelivery";
import type { DeliveryPhase, DeliveryResult } from "./types/meetingDelivery";

const PROCESSING_COLOR = 0x3498db;
const SUMMARY_COLOR = 0x00ae86;
const DEFAULT_TITLE = "Meeting Summary";
const MAX_FIELD_VALUE = 1024;
const MAX_EMBED_DESCRIPTION = 4000;
const MAX_EMBEDS_PER_MESSAGE = 10;
// Prefer newline breaks only when a meaningful portion of the chunk is filled.
const NEWLINE_CUT_FRACTION = 0.6;

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
  const endLabel = meeting.endTime
    ? formatTimestamp(meeting.endTime)
    : "Unknown";
  const durationLabel = meeting.endTime
    ? formatDurationMinutes(meeting.startTime, meeting.endTime)
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
      summary && summary.length > 0 ? summary : "Summary unavailable.",
    )
    .addFields(buildMeetingFields(meeting))
    .setTimestamp();
}

function chunkText(text: string, maxLength: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const lastNewline = slice.lastIndexOf("\n");
    const minPreferred = Math.floor(maxLength * NEWLINE_CUT_FRACTION);
    const cutIndex =
      lastNewline >= minPreferred && lastNewline !== -1
        ? lastNewline
        : maxLength;
    const chunk = remaining.slice(0, cutIndex).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cutIndex).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}

function buildNotesEmbeds(meeting: MeetingData): EmbedBuilder[] {
  if (!meeting.generateNotes) return [];
  const notes = meeting.notesText?.trim();
  if (!notes) {
    return [
      new EmbedBuilder()
        .setTitle("Meeting Notes")
        .setColor(SUMMARY_COLOR)
        .setDescription("Notes unavailable.")
        .setTimestamp(),
    ];
  }
  const chunks = chunkText(notes, MAX_EMBED_DESCRIPTION);
  return chunks.map((chunk, index) =>
    new EmbedBuilder()
      .setTitle(
        chunks.length > 1
          ? `Meeting Notes (${index + 1}/${chunks.length})`
          : "Meeting Notes",
      )
      .setColor(SUMMARY_COLOR)
      .setDescription(chunk)
      .setTimestamp(),
  );
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

function buildSummaryComponents(
  meeting: MeetingData,
  portalUrl: string,
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
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Open in Chronote")
        .setEmoji("\u{1F680}")
        .setStyle(ButtonStyle.Link)
        .setURL(portalUrl),
    ),
  );
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
export async function updateMeetingMessage(
  meeting: MeetingData,
  payload: MeetingMessagePayload,
  phase: Exclude<DeliveryPhase, "notes">,
): Promise<{ message?: Message; delivery: DeliveryResult }> {
  const channel = meeting.textChannel;
  const errors: DeliveryResult["errors"] = [];
  if (meeting.startMessageId) {
    try {
      const message = await channel.messages.fetch(meeting.startMessageId);
      await message.edit(payload);
      return {
        message,
        delivery: recordDelivery(meeting, phase, {
          outcome: "edited_existing",
          intended: 1,
          sent: 1,
          errors,
        }),
      };
    } catch (error) {
      errors.push(deliveryError(error));
    }
  }

  try {
    const message = await channel.send(payload);
    meeting.startMessageId = message.id;
    return {
      message,
      delivery: recordDelivery(meeting, phase, {
        outcome: "sent_fallback",
        intended: 1,
        sent: 1,
        errors,
      }),
    };
  } catch (error) {
    errors.push(deliveryError(error));
    return {
      delivery: recordDelivery(meeting, phase, {
        outcome: "failed",
        intended: 1,
        sent: 0,
        errors,
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

export async function updateMeetingSummaryMessage(
  meeting: MeetingData,
): Promise<{ summary: DeliveryResult; notes: DeliveryResult }> {
  const portalUrl = buildMeetingPortalUrl(meeting);
  const summaryPayload: MeetingMessagePayload = {
    embeds: [buildSummaryEmbed(meeting)],
    components: buildSummaryComponents(meeting, portalUrl),
  };
  const { message: summaryMessage, delivery: summary } =
    await updateMeetingMessage(meeting, summaryPayload, "summary");
  if (summaryMessage) {
    meeting.summaryMessageId = summaryMessage.id;
  }

  const noteEmbeds = buildNotesEmbeds(meeting);
  const noteMessages: Message[] = [];
  const errors: DeliveryResult["errors"] = [];
  for (let i = 0; i < noteEmbeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const payload: MeetingMessagePayload = {
      embeds: noteEmbeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE),
      components: [],
    };
    try {
      const message = await meeting.textChannel.send(payload);
      noteMessages.push(message);
    } catch (error) {
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
  const intended = Math.ceil(noteEmbeds.length / MAX_EMBEDS_PER_MESSAGE);
  const sent = noteMessages.length;
  const notes = recordDelivery(meeting, "notes", {
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
  return { summary, notes };
}
