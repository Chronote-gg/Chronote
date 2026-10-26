import type { MeetingHistory } from "../../src/types/db";
import type { MeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import {
  history,
  now,
  pending,
  pointers,
} from "../types/meetingUpdateDelivery.fixture";
import {
  buildMeetingNotesEmbeds,
  batchMeetingNotesEmbeds,
} from "../../src/utils/meetingNotes";
import { discordEditorMessageSchema } from "../../src/services/discordMessageEditor";

export const botId = "999999999999999989";
export const summaryId = "999999999999999988";
export function message(id: string, embeds: Record<string, unknown>[]) {
  return discordEditorMessageSchema.parse({
    id,
    channel_id: pointers.notesChannelId,
    author: { id: botId, bot: true },
    content: "",
    embeds,
    components: [],
    attachments: [],
    flags: 0,
  });
}
export function fixture(beforeNotes = "Old notes", notes = "Edited notes") {
  const rendered = buildMeetingNotesEmbeds({
    notesBody: beforeNotes,
    footerText: "v1",
  });
  const messages = batchMeetingNotesEmbeds(rendered).map((embeds, index) =>
    message(
      String(999990 + index),
      embeds.map((embed) => ({ ...embed.toJSON() })),
    ),
  );
  const summary = message(summaryId, [
    {
      title: "Manually different title",
      description: "Manually different summary",
      color: 123,
      timestamp: "2026-10-22T00:00:00.000Z",
      fields: [
        { name: "Start time", value: "12:00" },
        { name: "Duration", value: "60 seconds" },
      ],
    },
  ]);
  const row: MeetingHistory & {
    updateDelivery: MeetingUpdateDelivery;
    notesMessageIds: string[];
    summaryMessageId: string;
    notesChannelId: string;
  } = {
    ...history(),
    ...pointers,
    notesMessageIds: messages.map((item) => item.id),
    summaryMessageId: summary.id,
    contentRevision: 1,
    notesVersion: 2,
    notes,
    summarySentence: "Canonical summary",
    summaryLabel: "Canonical label",
    updateDelivery: pending(),
  };
  return {
    history: row,
    attemptId: "planned-attempt",
    observedAt: now,
    botId,
    channels: [{ id: pointers.notesChannelId, guild_id: row.guildId, type: 0 }],
    messages: [...messages, summary],
  };
}

export function notesWarningFixture(beforeNotes = "Old notes") {
  const input = fixture(beforeNotes);
  input.history.processing = { transcription: "partial" };
  input.history.updateDelivery.parts.notesBody = {
    desired: 0,
    acknowledged: 0,
  };
  input.history.updateDelivery.parts.notesWarning = {
    desired: 1,
    acknowledged: 0,
  };
  return input;
}

export function titleOnlyFixture(
  meetingName: string,
  beforeNotes = "Old notes",
) {
  const input = fixture(beforeNotes);
  input.history.meetingName = meetingName;
  input.history.updateDelivery.parts.notesBody = {
    desired: 0,
    acknowledged: 0,
  };
  input.history.updateDelivery.parts.notesTitle = {
    desired: 1,
    acknowledged: 0,
  };
  input.history.updateDelivery.parts.summaryTitle = {
    desired: 1,
    acknowledged: 0,
  };
  return input;
}
