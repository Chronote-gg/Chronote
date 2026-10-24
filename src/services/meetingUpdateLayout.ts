import { z } from "zod";
import {
  discordChannelSchema,
  discordEditorMessageSchema,
  type DiscordEditorMessage,
} from "./discordMessageEditor";
import {
  editableEmbedSchema,
  normalizePublicationEmbeds,
} from "./recoveryDiscordPublicationTypes";
import {
  isNotesEmbed,
  hasNotesEmbedShape,
  isSummaryEmbed,
  validateLimits,
  type EditableEmbed,
} from "./discordEmbedLayout";
import {
  meetingUpdateMessageFingerprint,
  observedMeetingUpdateCreationFingerprint,
} from "./meetingUpdateFingerprint";
import {
  MeetingUpdatePlanBlocked,
  type MeetingUpdatePlanInput,
} from "./meetingUpdatePlanTypes";
import { notesPointersSchema } from "../types/meetingUpdateDelivery";

export type MeetingUpdateLayout = {
  message: DiscordEditorMessage;
  embeds: EditableEmbed[];
  notesSlots: number[];
  summarySlots: number[];
};
const embedKeys = new Set([...Object.keys(editableEmbedSchema.shape), "type"]);
const nestedKeys: Record<string, Set<string>> = {
  footer: new Set(["text", "icon_url", "proxy_icon_url"]),
  author: new Set(["name", "url", "icon_url", "proxy_icon_url"]),
  image: new Set(["url", "proxy_url", "width", "height"]),
  thumbnail: new Set(["url", "proxy_url", "width", "height"]),
};
export function validateMeetingUpdateEmbeds(
  embeds: Record<string, unknown>[],
): EditableEmbed[] {
  for (const embed of embeds) {
    if (
      Object.keys(embed).some((key) => !embedKeys.has(key)) ||
      (embed.type !== undefined && embed.type !== "rich")
    )
      throw new MeetingUpdatePlanBlocked("unsupported_embed");
    validateEmbedMetadata(embed);
  }
  const normalized = normalizePublicationEmbeds(embeds);
  validateLimits(normalized);
  return normalized;
}
function validateEmbedMetadata(embed: Record<string, unknown>): void {
  for (const [key, allowed] of Object.entries(nestedKeys)) {
    const value = embed[key];
    if (value !== undefined) {
      const parsed = z.record(z.string(), z.unknown()).parse(value);
      if (Object.keys(parsed).some((name) => !allowed.has(name)))
        throw new MeetingUpdatePlanBlocked("unsupported_embed");
    }
  }
  if (embed.fields !== undefined) {
    const fields = z
      .array(z.record(z.string(), z.unknown()))
      .parse(embed.fields);
    if (
      fields.some((field) =>
        Object.keys(field).some(
          (key) => !["name", "value", "inline"].includes(key),
        ),
      )
    )
      throw new MeetingUpdatePlanBlocked("unsupported_embed");
  }
}
export function notesPointers(input: MeetingUpdatePlanInput) {
  return notesPointersSchema.parse({
    notesChannelId: input.history.notesChannelId ?? null,
    notesMessageIds: input.history.notesMessageIds ?? [],
  });
}
function readLayout(
  input: MeetingUpdatePlanInput,
  channelId: string,
  messageId: string,
  allowFooterlessRename = false,
): MeetingUpdateLayout {
  const found = input.messages.filter((message) => message.id === messageId);
  if (!found.length) throw new MeetingUpdatePlanBlocked("missing_target");
  if (found.length !== 1) throw new MeetingUpdatePlanBlocked("aliased_target");
  const message = discordEditorMessageSchema.parse(found[0]);
  const channels = input.channels.filter((channel) => channel.id === channelId);
  if (channels.length !== 1)
    throw new MeetingUpdatePlanBlocked("inaccessible_destination");
  const channel = discordChannelSchema.parse(channels[0]);
  if (
    channel.guild_id !== input.history.guildId ||
    ![0, 5, 10, 11, 12].includes(channel.type)
  )
    throw new MeetingUpdatePlanBlocked("inaccessible_destination");
  if (
    message.channel_id !== channelId ||
    message.author.id !== input.botId ||
    !message.author.bot ||
    message.webhook_id ||
    (message.flags & 32768) !== 0
  )
    throw new MeetingUpdatePlanBlocked("unsupported_owner");
  const embeds = validateMeetingUpdateEmbeds(message.embeds);
  const notesSlots = findRoutineNotesSlots(
    embeds,
    input.history.meetingName,
    allowFooterlessRename,
  );
  return {
    message,
    embeds,
    notesSlots,
    summarySlots: embeds.flatMap((embed, index) =>
      isSummaryEmbed(embed) ? [index] : [],
    ),
  };
}
function findRoutineNotesSlots(
  embeds: EditableEmbed[],
  meetingName: string | undefined,
  allowFooterlessRename: boolean,
): number[] {
  const recognized = embeds.flatMap((embed, index) =>
    isNotesEmbed(embed, meetingName) ? [index] : [],
  );
  if (recognized.length || !allowFooterlessRename) return recognized;
  const candidates = embeds.flatMap((embed, index) =>
    !embed.footer && hasNotesEmbedShape(embed) ? [index] : [],
  );
  return candidates.length === 1 || coherentFooterlessPages(embeds, candidates)
    ? candidates
    : [];
}
function coherentFooterlessPages(
  embeds: EditableEmbed[],
  candidates: number[],
): boolean {
  const labels = candidates.map((index) => readPageLabel(embeds[index]));
  const first = labels[0];
  if (first?.kind !== "page") return false;
  return labels.every(
    (label, index) =>
      label.kind === "page" &&
      label.baseTitle === first.baseTitle &&
      label.total === first.total &&
      label.number === first.number + index &&
      label.number <= label.total,
  );
}
function readRegisteredLayouts(input: MeetingUpdatePlanInput) {
  const pointers = notesPointers(input);
  const summaryId = input.history.summaryMessageId;
  if (summaryId && pointers.notesMessageIds.includes(summaryId))
    throw new MeetingUpdatePlanBlocked("aliased_target");
  const notesChannelId = pointers.notesChannelId;
  const notes = notesChannelId
    ? pointers.notesMessageIds.map((id) =>
        readLayout(
          input,
          notesChannelId,
          id,
          requestedPart(input, "notesTitle"),
        ),
      )
    : [];
  for (const layout of notes)
    if (!layout.notesSlots.length || layout.summarySlots.length)
      throw new MeetingUpdatePlanBlocked("unsupported_notes_layout");
  const summary = summaryId
    ? readLayout(
        input,
        input.history.textChannelId ?? pointers.notesChannelId ?? "",
        summaryId,
      )
    : undefined;
  if (
    summary &&
    (summary.summarySlots.length !== 1 || summary.notesSlots.length)
  )
    throw new MeetingUpdatePlanBlocked("unsupported_summary_layout");
  validatePagination(notes, input);
  return { notes, summary };
}
function readCreatedLayouts(
  input: MeetingUpdatePlanInput,
): MeetingUpdateLayout[] {
  const pointers = notesPointers(input);
  const summaryId = input.history.summaryMessageId;
  const delivery = input.history.updateDelivery;
  const retained: MeetingUpdateLayout[] = [];
  for (const candidate of delivery?.createdCandidates ?? []) {
    if (pointers.notesMessageIds.includes(candidate.messageId)) {
      if (candidate.channelId !== pointers.notesChannelId)
        throw new MeetingUpdatePlanBlocked("aliased_target");
      continue;
    }
    if (candidate.messageId === summaryId)
      throw new MeetingUpdatePlanBlocked("aliased_target");
    const layout = readLayout(input, candidate.channelId, candidate.messageId);
    if (
      observedMeetingUpdateCreationFingerprint(layout.message) !==
      candidate.fingerprint
    )
      throw new MeetingUpdatePlanBlocked("retained_target_changed");
    retained.push(layout);
  }
  return retained;
}
function readCleanupLayouts(
  input: MeetingUpdatePlanInput,
): MeetingUpdateLayout[] {
  const pointers = notesPointers(input);
  const summaryId = input.history.summaryMessageId;
  const delivery = input.history.updateDelivery;
  const retained: MeetingUpdateLayout[] = [];
  for (const candidate of delivery?.cleanupCandidates ?? []) {
    if (pointers.notesMessageIds.includes(candidate.messageId))
      throw new MeetingUpdatePlanBlocked("retained_target_registered");
    if (candidate.messageId === summaryId)
      throw new MeetingUpdatePlanBlocked("aliased_target");
    const layout = readLayout(input, candidate.channelId, candidate.messageId);
    if (
      meetingUpdateMessageFingerprint(layout.message) !==
      candidate.beforeFingerprint
    )
      throw new MeetingUpdatePlanBlocked("retained_target_changed");
    retained.push(layout);
  }
  return retained;
}
export function readMeetingUpdateLayouts(input: MeetingUpdatePlanInput) {
  const { notes, summary } = readRegisteredLayouts(input);
  const retained = [...readCreatedLayouts(input), ...readCleanupLayouts(input)];
  const uniqueRetained = retained.filter(
    (layout, index) =>
      retained.findIndex((other) => other.message.id === layout.message.id) ===
      index,
  );
  for (const layout of uniqueRetained) assertDeletableNotesLayout(layout);
  return { notes, summary, retained: uniqueRetained };
}
type PageLabel =
  | { kind: "single"; baseTitle: string }
  | { kind: "page"; baseTitle: string; number: number; total: number };
function readPageLabel(embed: EditableEmbed): PageLabel {
  const title = embed.title ?? "";
  const match = / \(part (\d+)\/(\d+)\)$/.exec(title);
  return match
    ? {
        kind: "page",
        baseTitle: title.slice(0, match.index),
        number: Number(match[1]),
        total: Number(match[2]),
      }
    : { kind: "single", baseTitle: title };
}
function requestedPart(
  input: MeetingUpdatePlanInput,
  part: "notesBody" | "notesTitle",
): boolean {
  const watermark = input.history.updateDelivery?.parts[part];
  return (watermark?.desired ?? 0) > (watermark?.acknowledged ?? 0);
}
function exactPageOrder(labels: PageLabel[]): boolean {
  if (labels.length === 1) return labels[0].kind === "single";
  return labels.every(
    (label, index) =>
      label.kind === "page" &&
      label.number === index + 1 &&
      label.total === labels.length,
  );
}
function anchoredPageOrder(labels: PageLabel[]): boolean {
  let previous = 0;
  for (const [index, label] of labels.entries()) {
    const number = label.kind === "single" ? 1 : label.number;
    if (
      (index === 0 && number !== 1) ||
      (label.kind === "single" && index !== 0) ||
      number <= previous
    )
      return false;
    if (label.kind === "page" && number > label.total) return false;
    previous = number;
  }
  return true;
}
function validatePagination(
  layouts: MeetingUpdateLayout[],
  input: MeetingUpdatePlanInput,
): void {
  const slots = layouts.flatMap((layout) =>
    layout.notesSlots.map((index) => layout.embeds[index]),
  );
  const labels = slots.map(readPageLabel);
  const sameTitle = labels.every(
    (label) => label.baseTitle === labels[0]?.baseTitle,
  );
  if (
    exactPageOrder(labels) &&
    (sameTitle || requestedPart(input, "notesTitle"))
  )
    return;
  const versioned = slots.some((embed) =>
    /^v\d+(?:$|[ •|])/.test(embed.footer?.text ?? ""),
  );
  if (
    requestedPart(input, "notesBody") &&
    versioned &&
    anchoredPageOrder(labels)
  )
    return;
  throw new MeetingUpdatePlanBlocked("unsupported_pagination");
}
export function assertDeletableNotesLayout(layout: MeetingUpdateLayout): void {
  const message = layout.message;
  if (
    !layout.notesSlots.length ||
    layout.summarySlots.length ||
    layout.notesSlots.length !== layout.embeds.length ||
    message.content !== "" ||
    message.components.length ||
    message.attachments.length ||
    message.flags !== 0
  )
    throw new MeetingUpdatePlanBlocked("protected_surplus");
}
