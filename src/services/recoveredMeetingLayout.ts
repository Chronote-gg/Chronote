import type { MeetingHistory } from "../types/db";
import { z } from "zod";
import {
  checkpointObjectSchema,
  recordingCaptureStateSchema,
  recordingCheckpointSchema,
  recoveryDispositionSchema,
} from "../types/recordingCheckpoint";
import { originalPublicationSettled } from "../types/meetingPublication";
import {
  meetingUpdateDeliverySchema,
  notesPointersSchema,
} from "../types/meetingUpdateDelivery";
import type { DeliveryResult } from "../types/meetingDelivery";
import { buildPortalMeetingUrl } from "../utils/portalLinks";
import { config } from "./configService";
import {
  hasNotesEmbedShape,
  isNotesEmbed,
  isSummaryEmbed,
  type EditableEmbed,
} from "./discordEmbedLayout";

function recoveredNotesSlots(
  embeds: EditableEmbed[],
  portalUrl: string,
  meetingName: string | undefined,
) {
  const linked = embeds.flatMap((embed, index) =>
    embed.url === portalUrl && hasNotesEmbedShape({ ...embed, url: undefined })
      ? [index]
      : [],
  );
  if (linked.length) {
    const base = (index: number) =>
      embeds[index].title?.replace(/ \(part \d+\/\d+\)$/, "");
    return {
      notesSlots: linked.every((index) => base(index) === base(linked[0]))
        ? linked
        : [],
      recoveredNotes: true,
    };
  }
  // Recovery sends one embed per message; later batched pages use normal version footers.
  if (
    embeds.length === 1 &&
    embeds[0].url === undefined &&
    hasNotesEmbedShape(embeds[0]) &&
    !isNotesEmbed(embeds[0], meetingName)
  )
    return { notesSlots: [0], recoveredNotes: true };
  return {
    notesSlots: embeds.flatMap((embed, index) =>
      isNotesEmbed(embed, meetingName) ? [index] : [],
    ),
    recoveredNotes: false,
  };
}

const recoveryEvidenceSchema = z.object({
  checkpoint: recordingCheckpointSchema,
  capture: recordingCaptureStateSchema,
  recovery: recoveryDispositionSchema,
  recoveryTranscript: z
    .object({
      checkpointRevision: recordingCheckpointSchema.shape.revision,
      object: checkpointObjectSchema,
    })
    .strict(),
});

function completePhase(phase: DeliveryResult | undefined): boolean {
  return (
    phase?.outcome === "complete" &&
    phase.intended > 0 &&
    phase.sent === phase.intended &&
    phase.errors.length === 0
  );
}
function completeOriginalPhases(history: MeetingHistory): boolean {
  return (
    Boolean(history.summaryMessageId) &&
    history.delivery?.summary?.intended === 1 &&
    completePhase(history.delivery.summary) &&
    completePhase(history.delivery.notes)
  );
}
function acknowledgedRecoveryDelivery(history: MeetingHistory): boolean {
  if (
    !["complete", "interrupted"].includes(history.status ?? "") ||
    history.publicationRepair?.kind === "running"
  )
    return false;
  if (originalPublicationSettled(history)) return true;
  const delivery = meetingUpdateDeliverySchema.safeParse(
    history.updateDelivery,
  );
  const pointers = notesPointersSchema.safeParse({
    notesChannelId: history.notesChannelId,
    notesMessageIds: history.notesMessageIds,
  });
  // Verified normal edits may change the number of registered notes messages.
  return (
    delivery.success &&
    delivery.data.policy.kind === "active" &&
    delivery.data.lastSuccess !== null &&
    delivery.data.lastSuccess.contentRevision <=
      (history.contentRevision ?? 0) &&
    pointers.success &&
    pointers.data.notesMessageIds.length > 0 &&
    completeOriginalPhases(history)
  );
}

function completedRecordingRecovery(history: MeetingHistory): boolean {
  const parsed = recoveryEvidenceSchema.safeParse(history);
  if (!parsed.success) return false;
  const { checkpoint, capture, recovery, recoveryTranscript } = parsed.data;
  const source = checkpoint.capture;
  return (
    recovery.disposition === "done" &&
    recovery.outcome === "completed" &&
    recovery.stage === "export" &&
    recovery.executionVersion === history.executionVersion &&
    (capture.kind === "complete" || capture.kind === "interrupted") &&
    source.guildId === history.guildId &&
    source.channelId === history.channelId &&
    source.channelId_timestamp === history.channelId_timestamp &&
    source.meetingId === history.meetingId &&
    recoveryTranscript.checkpointRevision === checkpoint.revision &&
    recoveryTranscript.object.byteLength > 0 &&
    recoveryTranscript.object.key.startsWith(
      checkpoint.artifactFolder + "recovery/",
    ) &&
    acknowledgedRecoveryDelivery(history)
  );
}

export function recoveredMeetingSlots(
  history: MeetingHistory,
  embeds: EditableEmbed[],
  role: "notes" | "summary",
) {
  if (!completedRecordingRecovery(history)) return undefined;
  const portalUrl = buildPortalMeetingUrl({
    baseUrl: config.frontend.siteUrl,
    guildId: history.guildId,
    meetingId: history.channelId_timestamp,
  });
  const managedShape = (embed: EditableEmbed) =>
    (embed.url === undefined || embed.url === portalUrl) &&
    hasNotesEmbedShape({ ...embed, url: undefined });
  if (role === "summary") {
    if (embeds.length !== 1 || embeds[0].footer || !managedShape(embeds[0]))
      return undefined;
    return { notesSlots: [], summarySlots: [0] };
  }
  return {
    ...recoveredNotesSlots(embeds, portalUrl, history.meetingName),
    summarySlots: embeds.flatMap((embed, index) =>
      isSummaryEmbed(embed) ? [index] : [],
    ),
  };
}
