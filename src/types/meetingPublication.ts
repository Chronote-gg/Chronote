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
    purpose: z.literal("first_publication").optional(),
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
/**
 * A lifecycle version 2 row is terminal before its notes reach Discord. While
 * its finish marker remains and delivery has neither completed nor been given
 * up, the original publication is still on its way, not absent.
 */
function lifecycleDeliveryPending(row: MeetingHistory): boolean {
  return (
    row.lifecycleVersion === 2 &&
    row.finish !== undefined &&
    row.textChannelId !== undefined &&
    (row.status === "complete" || row.status === "interrupted") &&
    row.recovery?.disposition !== "done" &&
    row.delivery?.notes?.outcome !== "failed"
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
  if (
    originalPublicationUnsettled(publicationSnapshot(row)) ||
    lifecycleDeliveryPending(row)
  )
    return { kind: "held", reason: "initial_publication_unsettled" };
  if (row.operatorRecovery)
    return { kind: "held", reason: "legacy_publication_unknown" };
  if (!row.notesChannelId && !row.summaryMessageId)
    return { kind: "unpublished" };
  return originalPublicationSettled(publicationSnapshot(row))
    ? { kind: "active" }
    : { kind: "held", reason: "legacy_publication_unknown" };
}
/**
 * A lifecycle version 2 row is terminal before its delivery finishes, so a
 * correction made in between is held as unknown although the publication is in
 * progress, not unknown. Its delivery settlement releases that hold too.
 */
function lifecycleHold(
  before: MeetingPublicationSnapshot & Pick<MeetingHistory, "lifecycleVersion">,
  reason: string,
) {
  return (
    reason === "initial_publication_unsettled" ||
    (reason === "legacy_publication_unknown" && before.lifecycleVersion === 2)
  );
}
type LifecycleBefore = MeetingPublicationSnapshot &
  Pick<MeetingHistory, "lifecycleVersion">;
function releasedLifecycleHold(
  before: LifecycleBefore,
  released: boolean,
  policy: MeetingUpdateDelivery["policy"],
  revisionPrefix: string,
  revisionInput: Partial<MeetingHistory>,
) {
  const delivery = before.updateDelivery;
  if (
    !released ||
    !delivery ||
    delivery.policy.kind !== "held" ||
    !lifecycleHold(before, delivery.policy.reason) ||
    "attempt" in delivery.progress
  )
    return undefined;
  const next: MeetingUpdateDelivery = {
    ...delivery,
    revision:
      revisionPrefix +
      createHash("sha256")
        .update(stableJson({ before, ...revisionInput }))
        .digest("hex"),
    policy,
  };
  return { delivery: next, dueAt: meetingUpdateDeliveryNextCheck(next) };
}
/** Only the original known settlement may release its lifecycle hold. Content holds survive. */
export function settledLifecycleDelivery(
  before: LifecycleBefore,
  patch: Partial<MeetingHistory>,
) {
  return releasedLifecycleHold(
    before,
    patch.recovery?.disposition === "done" &&
      originalPublicationSettled({ ...before, ...patch }),
    { kind: "active" },
    "settled-",
    { recovery: patch.recovery },
  );
}
/**
 * Delivery given up means the original notes were never published, so a
 * correction held for them is kept as unpublished instead of waiting forever.
 */
export function abandonedLifecycleDelivery(
  before: LifecycleBefore,
  patch: Partial<MeetingHistory>,
) {
  return patch.delivery?.notes?.outcome === "failed"
    ? unpublishedLifecycleDelivery(before, { delivery: patch.delivery })
    : undefined;
}
/** A finished meeting whose delivery will not run keeps its held correction as unpublished. */
export function unpublishedLifecycleDelivery(
  before: LifecycleBefore,
  revisionInput: Partial<MeetingHistory>,
) {
  return releasedLifecycleHold(
    before,
    true,
    { kind: "unpublished" },
    "abandoned-",
    revisionInput,
  );
}

export class PublicationArchiveConflict extends Error {
  constructor() {
    super(
      "Meeting publication is running or unresolved; reconcile before archiving.",
    );
    this.name = "PublicationArchiveConflict";
  }
}
