import { buildPaginatedEmbeds } from "./embedPagination";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import { getMeetingProcessingNotice } from "./meetingProcessing";

const DEFAULT_NOTES_EMBED_TITLE = "Meeting Notes";
const EMBED_FOOTER_LIMIT = 2048;

function combineFooterText(
  footerText: string | undefined,
  noticeText: string | undefined,
): string | undefined {
  if (!noticeText) return footerText;
  if (!footerText) return noticeText;
  const separator = " • ";
  const available = EMBED_FOOTER_LIMIT - separator.length - noticeText.length;
  return `${footerText.slice(0, Math.max(0, available))}${separator}${noticeText}`;
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
  return buildPaginatedEmbeds({
    text: hasNotes ? params.notesBody : (notice?.text ?? params.notesBody),
    baseTitle,
    footerText: combineFooterText(
      params.footerText,
      hasNotes && notice?.tone === "warning" ? notice.text : undefined,
    ),
    color: params.color,
  });
}
