import {
  originalPublicationUnsettled,
  publicationSnapshot,
} from "../types/meetingPublication";
import type { MeetingHistory } from "../types/db";
import {
  presentationPartSchema,
  readMeetingUpdateRevisions,
} from "../types/meetingUpdateDelivery";

type Delivery = NonNullable<MeetingHistory["updateDelivery"]>;
export type MeetingUpdatePublicReason =
  | "repair_publication_unsettled"
  | Extract<Delivery["policy"], { kind: "held" }>["reason"]
  | Extract<
      Delivery["progress"],
      { kind: "blocked" | "uncertain" | "retrying" }
    >["reason"];
type Revisions = {
  desiredRevision: number;
  syncedRevision: number | null;
  lastSuccess: Delivery["lastSuccess"];
};
export type MeetingUpdatePublicDelivery = Revisions &
  (
    | { status: "synced"; reason: null; pollable: false }
    | {
        status: "pending";
        reason: MeetingUpdatePublicReason | null;
        pollable: true;
      }
    | {
        status: "held" | "blocked" | "uncertain";
        reason: MeetingUpdatePublicReason;
        pollable: false;
      }
    | { status: "unpublished"; reason: null; pollable: false }
  );

/** Last success describes a captured attempt, never historical whole-meeting convergence. */
export function projectMeetingUpdateDelivery(
  history: MeetingHistory,
): MeetingUpdatePublicDelivery {
  const desiredRevision = readMeetingUpdateRevisions(history).contentRevision;
  const delivery = history.updateDelivery;
  const revisions = {
    desiredRevision,
    syncedRevision: null,
    lastSuccess: delivery?.lastSuccess ?? null,
  };
  if (history.publicationRepair?.kind === "running")
    return {
      ...revisions,
      status: "held",
      reason: "repair_publication_unsettled",
      pollable: false,
    };
  if (originalPublicationUnsettled(publicationSnapshot(history)))
    return {
      ...revisions,
      status: "held",
      reason: "initial_publication_unsettled",
      pollable: false,
    };
  if (!delivery)
    return history.notesChannelId || history.summaryMessageId
      ? {
          ...revisions,
          status: "held",
          reason: "legacy_publication_unknown",
          pollable: false,
        }
      : { ...revisions, status: "unpublished", reason: null, pollable: false };
  if (delivery.policy.kind === "unpublished")
    return {
      ...revisions,
      status: "unpublished",
      reason: null,
      pollable: false,
    };
  if (delivery.policy.kind === "held")
    return {
      ...revisions,
      status: "held",
      reason: delivery.policy.reason,
      pollable: false,
    };
  return projectActiveDelivery({ delivery, revisions });
}
function projectActiveDelivery(input: {
  delivery: Delivery;
  revisions: Revisions;
}): MeetingUpdatePublicDelivery {
  const { delivery, revisions } = input;
  const desiredRevision = revisions.desiredRevision;
  const progress = delivery.progress;
  if (progress.kind === "blocked" || progress.kind === "uncertain")
    return {
      ...revisions,
      status: progress.kind,
      reason: progress.reason,
      pollable: false,
    };
  if (
    progress.kind === "synced" &&
    presentationPartSchema.options.every(
      (part) =>
        delivery.parts[part].desired === delivery.parts[part].acknowledged,
    ) &&
    delivery.lastSuccess?.contentRevision === desiredRevision &&
    delivery.lastSuccess.at === progress.syncedAt
  )
    return {
      ...revisions,
      syncedRevision: desiredRevision,
      status: "synced",
      reason: null,
      pollable: false,
    };
  if (progress.kind === "synced")
    return {
      ...revisions,
      status: "held",
      reason: "legacy_publication_unknown",
      pollable: false,
    };
  return {
    ...revisions,
    status: "pending",
    reason: progress.kind === "retrying" ? progress.reason : null,
    pollable: true,
  };
}
