import { stableJson } from "../utils/stableJson";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MeetingHistory } from "./db";
import {
  meetingUpdateDeliveryNextCheck,
  type MeetingUpdateDelivery,
} from "./meetingUpdateDelivery";

export const repairPublicationOwnerSchema = z
  .object({
    kind: z.enum(["running", "settled"]),
    runId: z.string().min(1).max(512),
    previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptKey: z.string().min(1).max(2048),
    snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RepairPublicationOwner = z.infer<
  typeof repairPublicationOwnerSchema
>;
export const PUBLICATION_SNAPSHOT_FIELDS = [
  "meetingId",
  "ownerInstanceId",
  "executionVersion",
  "canonicalWriter",
  "status",
  "checkpoint",
  "recovery",
  "recoveryExport",
  "completionPolicy",
  "processing",
  "delivery",
  "notesChannelId",
  "notesMessageIds",
  "summaryMessageId",
  "notesDeliveryTiming",
  "contentRevision",
  "contentMutation",
  "updateDelivery",
  "publicationRepair",
  "operatorRecovery",
  "notes",
  "notesVersion",
  "notesDelta",
  "notesHistory",
  "notesLastEditedBy",
  "notesLastEditedAt",
  "suggestionsHistory",
  "meetingName",
  "summarySentence",
  "summaryLabel",
] as const;
export type MeetingPublicationSnapshot = Pick<
  MeetingHistory,
  (typeof PUBLICATION_SNAPSHOT_FIELDS)[number]
>;
export function publicationSnapshot(
  row: MeetingHistory,
): MeetingPublicationSnapshot {
  return Object.fromEntries(
    PUBLICATION_SNAPSHOT_FIELDS.map((field) => [field, row[field]]),
  ) as MeetingPublicationSnapshot;
}
export function matchesPublicationSnapshot(
  row: MeetingHistory,
  expected: MeetingPublicationSnapshot,
): boolean {
  return isDeepStrictEqual(publicationSnapshot(row), expected);
}
export function publicationSnapshotDigest(row: MeetingHistory): string {
  return createHash("sha256")
    .update(
      stableJson({ ...publicationSnapshot(row), publicationRepair: undefined }),
    )
    .digest("hex");
}
export function publicationSnapshotCondition(
  snapshot: MeetingPublicationSnapshot,
  prefix = "publication",
) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const conditions = PUBLICATION_SNAPSHOT_FIELDS.map((field, index) => {
    const name = "#" + prefix + index,
      value = ":" + prefix + index;
    names[name] = field;
    if (snapshot[field] === undefined)
      return "attribute_not_exists(" + name + ")";
    values[value] = snapshot[field];
    return name + " = " + value;
  });
  return { names, values, condition: conditions.join(" AND ") };
}
export function originalPublicationUnsettled(
  row: MeetingPublicationSnapshot,
): boolean {
  if (["starting", "in_progress", "processing"].includes(row.status ?? ""))
    return true;
  return Boolean(row.recovery && row.recovery.disposition !== "done");
}
export function publicationMutationExcluded(
  row: MeetingPublicationSnapshot,
): boolean {
  return (
    row.publicationRepair?.kind === "running" ||
    originalPublicationUnsettled(row)
  );
}
type PublicationPhase = NonNullable<
  NonNullable<MeetingHistory["delivery"]>["notes"]
>;
function acknowledgedPhase(
  phase: PublicationPhase | undefined,
  kind: "summary" | "notes",
): phase is PublicationPhase {
  return (
    phase !== undefined &&
    (phase.outcome === "complete" ||
      (kind === "summary" &&
        (phase.outcome === "edited_existing" ||
          phase.outcome === "sent_fallback"))) &&
    phase.intended > 0 &&
    phase.sent === phase.intended &&
    phase.errors.length === 0
  );
}
function notesPublicationSettled(row: MeetingPublicationSnapshot): boolean {
  const notes = row.delivery?.notes;
  return (
    acknowledgedPhase(notes, "notes") &&
    row.notesMessageIds?.length === notes.intended &&
    new Set(row.notesMessageIds).size === notes.intended &&
    Boolean(row.notesChannelId)
  );
}
export function originalPublicationSettled(
  row: MeetingPublicationSnapshot,
): boolean {
  const summary = row.delivery?.summary;
  return (
    ["complete", "interrupted"].includes(row.status ?? "") &&
    !publicationMutationExcluded(row) &&
    (!row.ownerInstanceId || row.recovery?.disposition === "done") &&
    acknowledgedPhase(summary, "summary") &&
    summary.intended === 1 &&
    Boolean(row.summaryMessageId) &&
    notesPublicationSettled(row)
  );
}
export function initialMeetingUpdatePolicy(
  row: MeetingHistory,
): MeetingUpdateDelivery["policy"] {
  if (row.updateDelivery) return row.updateDelivery.policy;
  if (
    row.ownershipScope === "personal" &&
    !row.notesChannelId &&
    !row.summaryMessageId
  )
    return { kind: "unpublished" };
  if (originalPublicationUnsettled(publicationSnapshot(row)))
    return { kind: "held", reason: "initial_publication_unsettled" };
  if (row.operatorRecovery)
    return { kind: "held", reason: "legacy_publication_unknown" };
  if (!row.notesChannelId && !row.summaryMessageId)
    return { kind: "unpublished" };
  return originalPublicationSettled(publicationSnapshot(row))
    ? { kind: "active" }
    : { kind: "held", reason: "legacy_publication_unknown" };
}
/** Only the original known settlement may release its lifecycle hold. Content holds survive. */
export function settledLifecycleDelivery(
  before: MeetingPublicationSnapshot,
  patch: Partial<MeetingHistory>,
) {
  const delivery = before.updateDelivery;
  if (
    !delivery ||
    delivery.policy.kind !== "held" ||
    delivery.policy.reason !== "initial_publication_unsettled" ||
    patch.recovery?.disposition !== "done" ||
    !originalPublicationSettled({ ...before, ...patch }) ||
    "attempt" in delivery.progress
  )
    return undefined;
  const next: MeetingUpdateDelivery = {
    ...delivery,
    revision:
      "settled-" +
      createHash("sha256")
        .update(stableJson({ before, recovery: patch.recovery }))
        .digest("hex"),
    policy: { kind: "active" },
  };
  return { delivery: next, dueAt: meetingUpdateDeliveryNextCheck(next) };
}
