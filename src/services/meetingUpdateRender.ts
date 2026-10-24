import { EmbedBuilder } from "discord.js";
import type { MeetingHistory } from "../types/db";
import type { PreparedMeetingUpdateAttempt } from "../types/meetingUpdateDelivery";
import {
  buildMeetingNotesEmbeds,
  formatNotesEmbedTitle,
  resolveNotesEmbedBaseTitle,
  batchMeetingNotesEmbeds,
} from "../utils/meetingNotes";
import {
  formatMeetingCaptureNotice,
  withMeetingCaptureNotice,
} from "../utils/meetingCaptureNotice";
import {
  getMeetingProcessingNotice,
  PARTIAL_TRANSCRIPT_NOTICE,
} from "../utils/meetingProcessing";
import { normalizePublicationEmbeds } from "./recoveryDiscordPublicationTypes";
import type { EditableEmbed } from "./discordEmbedLayout";
import type { MeetingUpdateLayout } from "./meetingUpdateLayout";
import { MeetingUpdatePlanBlocked } from "./meetingUpdatePlanTypes";

type Captured = PreparedMeetingUpdateAttempt["capturedParts"];
const interruptedNotice =
  /^Partial notes: recording was interrupted\. These notes cover only the saved recording\. (?:Confirmed saved audio: \d+(?:\.\d+)? seconds\. Saved audio may contain gaps\.|Saved recording coverage is unknown\.)(?: The exact recording end time is unknown\.)?(?: Some audio could not be transcribed\. These notes may be incomplete\.)?$/;
function knownNotice(text: string): boolean {
  return text === PARTIAL_TRANSCRIPT_NOTICE || interruptedNotice.test(text);
}
function stripNotice(text: string, required?: string): string {
  const first = text.split("\n\n", 1)[0];
  if (first === required || knownNotice(first))
    return text.slice(first.length + 2);
  if (first.startsWith("Partial notes: recording was interrupted."))
    throw new MeetingUpdatePlanBlocked("unsupported_notice");
  return text;
}
function requiredNotesFooterNotice(
  history: MeetingHistory,
): string | undefined {
  return (
    getMeetingProcessingNotice(
      history.processing,
      Boolean(history.notes?.trim()),
    )?.text ?? formatMeetingCaptureNotice(history)
  );
}
function notesCapturePrefix(history: MeetingHistory): string | undefined {
  return history.capture?.kind === "interrupted" ||
    history.status === "interrupted"
    ? formatMeetingCaptureNotice(history)
    : undefined;
}
function footerPrefix(current: EditableEmbed, fallback: string): string {
  const footer = current.footer?.text ?? "";
  if (!footer || knownNotice(footer)) return fallback;
  const match =
    /^(v\d+(?: \| Recovered notes| • Edited by [^•]+| - Imported by [^•]+)?)(?: • (.*))?$/.exec(
      footer,
    );
  if (!match) throw new MeetingUpdatePlanBlocked("unsupported_footer");
  if (match[2] && !knownNotice(match[2]))
    throw new MeetingUpdatePlanBlocked("unsupported_notice");
  return match[1].trimEnd();
}
export function renderNotesUpdate(
  history: MeetingHistory,
  captured: Captured,
  layouts: MeetingUpdateLayout[],
) {
  const slots = layouts.flatMap((layout) =>
    layout.notesSlots.map((index) => layout.embeds[index]),
  );
  const first = slots[0];
  if (!first) throw new MeetingUpdatePlanBlocked("missing_target");
  const base = captured.notesTitle
    ? resolveNotesEmbedBaseTitle(history.meetingName)
    : first.title?.replace(/ \(part \d+\/\d+\)$/, "");
  if (!base) throw new MeetingUpdatePlanBlocked("unsupported_notes_layout");
  if (captured.notesBody) {
    for (const slot of slots)
      footerPrefix(slot, `v${history.notesVersion ?? 1}`);
    const version = `v${history.notesVersion ?? 1}`;
    const rendered = buildMeetingNotesEmbeds({
      ...history,
      notesBody: history.notes ?? "",
      meetingName: "Meeting Notes",
      footerText: version,
    });
    for (const [index, embed] of rendered.entries()) {
      const title = formatNotesEmbedTitle(base, index, rendered.length);
      if (title.length > 256) throw new MeetingUpdatePlanBlocked("title_limit");
      embed.setTitle(title);
    }
    const notice = requiredNotesFooterNotice(history);
    const embeds = normalizePublicationEmbeds(
      rendered.map((embed) => embed.toJSON()),
    ).map((embed) => ({
      ...first,
      ...embed,
      footer: { ...first.footer, text: embed.footer?.text ?? "" },
    }));
    if (
      embeds.some(
        (embed) =>
          !embed.footer?.text.startsWith(version) ||
          (notice &&
            history.notes?.trim() &&
            !embed.footer?.text.includes(notice)),
      )
    )
      throw new MeetingUpdatePlanBlocked("truncated_notice");
    return embeds;
  }
  const footerNotice = requiredNotesFooterNotice(history);
  const captureNotice = notesCapturePrefix(history);
  const embeds = slots.map((slot, index) => {
    const next = { ...slot };
    if (captured.notesTitle)
      next.title = formatNotesEmbedTitle(base, index, slots.length);
    if (captured.notesWarning) {
      const prefix = footerPrefix(slot, `v${history.notesVersion ?? 1}`);
      next.footer = {
        ...slot.footer,
        text: footerNotice ? `${prefix} • ${footerNotice}` : prefix,
      };
      const body = notesBodyWithoutManagedNotice(slot, captureNotice);
      next.description = captureNotice ? `${captureNotice}\n\n${body}` : body;
    }
    return next;
  });
  return embeds;
}
function footerHasNotice(slot: EditableEmbed, notice: string): boolean {
  const footer = slot.footer?.text ?? "";
  return footer === notice || footer.endsWith(" • " + notice);
}
function notesBodyWithoutManagedNotice(
  slot: EditableEmbed,
  capturePrefix: string | undefined,
): string {
  const description = slot.description ?? "";
  const prefix = description.split("\n\n", 1)[0];
  const provenCapturePrefix =
    interruptedNotice.test(prefix) &&
    (footerHasNotice(slot, prefix) ||
      (prefix === capturePrefix &&
        prefix.endsWith(" " + PARTIAL_TRANSCRIPT_NOTICE) &&
        footerHasNotice(slot, PARTIAL_TRANSCRIPT_NOTICE)));
  return provenCapturePrefix
    ? description.slice(prefix.length + 2)
    : description;
}
function summaryBodyText(history: MeetingHistory): string {
  const summary =
    history.summarySentence?.trim() ?? history.summaryLabel?.trim();
  return summary && summary.length ? summary : "Summary unavailable.";
}
export function mergeNotesUpdate(
  current: Record<string, unknown>,
  candidate: EditableEmbed,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...current,
    title: candidate.title,
    description: candidate.description,
  };
  if (candidate.footer)
    result.footer = {
      ...(typeof current.footer === "object" && current.footer !== null
        ? current.footer
        : {}),
      text: candidate.footer.text,
    };
  return result;
}
export function renderSummaryUpdate(
  history: MeetingHistory,
  captured: Captured,
  layout: MeetingUpdateLayout,
): Record<string, unknown>[] {
  const after = structuredClone(layout.message.embeds);
  const index = layout.summarySlots[0];
  const current = layout.embeds[index];
  const summary = { ...after[index] };
  if (captured.summaryTitle)
    summary.title =
      history.meetingName?.trim() ||
      history.summaryLabel?.trim() ||
      "Meeting Summary";
  if (captured.summaryBody)
    summary.description = withMeetingCaptureNotice(
      summaryBodyText(history),
      history,
    );
  else if (captured.summaryWarning)
    summary.description = withMeetingCaptureNotice(
      stripNotice(
        current.description ?? "",
        formatMeetingCaptureNotice(history),
      ),
      history,
    );
  after[index] = summary;
  return after;
}

export function batchRenderedNotesPages(
  pages: EditableEmbed[],
): Record<string, unknown>[][] {
  return batchMeetingNotesEmbeds(
    pages.map((page) => new EmbedBuilder(page)),
  ).map((batch) => batch.map((embed) => ({ ...embed.toJSON() })));
}
