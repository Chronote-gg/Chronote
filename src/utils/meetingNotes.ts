import { buildPaginatedEmbeds } from "./embedPagination";
import type { EmbedBuilder } from "discord.js";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import { getMeetingProcessingNotice } from "./meetingProcessing";

const DEFAULT_NOTES_EMBED_TITLE = "Meeting Notes";
const EMBED_FOOTER_LIMIT = 2048;
const MESSAGE_EMBED_TEXT_LIMIT = 6000;
const MESSAGE_EMBED_COUNT_LIMIT = 10;

function combineFooterText(
  footerText: string | undefined,
  noticeText: string | undefined,
  maxLength = EMBED_FOOTER_LIMIT,
): string | undefined {
  if (maxLength <= 0) return undefined;
  if (!noticeText) return footerText?.slice(0, maxLength);
  if (!footerText) return noticeText.slice(0, maxLength);
  const separator = " • ";
  const available = maxLength - separator.length - noticeText.length;
  return `${footerText.slice(0, Math.max(0, available))}${separator}${noticeText}`;
}

function embedTextLength(embed: EmbedBuilder): number {
  const data = embed.toJSON();
  return (
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text.length ?? 0) +
    (data.author?.name.length ?? 0) +
    (data.fields?.reduce(
      (total, field) => total + field.name.length + field.value.length,
      0,
    ) ?? 0)
  );
}

export function batchMeetingNotesEmbeds(
  embeds: EmbedBuilder[],
): EmbedBuilder[][] {
  const batches: EmbedBuilder[][] = [];
  let batch: EmbedBuilder[] = [];
  let textLength = 0;

  for (const embed of embeds) {
    const nextLength = embedTextLength(embed);
    if (
      batch.length > 0 &&
      (batch.length === MESSAGE_EMBED_COUNT_LIMIT ||
        textLength + nextLength > MESSAGE_EMBED_TEXT_LIMIT)
    ) {
      batches.push(batch);
      batch = [];
      textLength = 0;
    }
    batch.push(embed);
    textLength += nextLength;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function resolveNotesEmbedBaseTitle(
  meetingName?: string | null,
): string {
  const trimmed = meetingName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_NOTES_EMBED_TITLE;
}

export function formatNotesEmbedTitle(
  baseTitle: string,
  index: number,
  total: number,
): string {
  if (total > 1) {
    return `${baseTitle} (part ${index + 1}/${total})`;
  }
  return baseTitle;
}

export function buildMeetingNotesEmbeds(params: {
  notesBody: string;
  meetingName?: string | null;
  footerText?: string;
  color?: number;
  processing?: MeetingProcessingOutcome;
}) {
  const baseTitle = resolveNotesEmbedBaseTitle(params.meetingName);
  const hasNotes = Boolean(params.notesBody.trim());
  const notice = getMeetingProcessingNotice(params.processing, hasNotes);
  const embeds = buildPaginatedEmbeds({
    text: hasNotes ? params.notesBody : (notice?.text ?? params.notesBody),
    baseTitle,
    color: params.color,
  });
  const noticeText =
    hasNotes && notice?.tone === "warning" ? notice.text : undefined;
  for (const embed of embeds) {
    const footerLimit = Math.min(
      EMBED_FOOTER_LIMIT,
      MESSAGE_EMBED_TEXT_LIMIT - embedTextLength(embed),
    );
    const footerText = combineFooterText(
      params.footerText,
      noticeText,
      footerLimit,
    );
    if (footerText) embed.setFooter({ text: footerText });
  }
  return embeds;
}
