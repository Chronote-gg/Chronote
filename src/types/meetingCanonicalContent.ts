import { z } from "zod";
import type { MeetingHistory } from "./db";
import type { MeetingUpdateMutation } from "./meetingUpdateDelivery";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const canonicalFieldRevisionsSchema = z
  .object({
    notes: revision.optional(),
    meetingName: revision.optional(),
    summarySentence: revision.optional(),
    summaryLabel: revision.optional(),
  })
  .strict();
export type CanonicalFieldRevisions = z.infer<
  typeof canonicalFieldRevisionsSchema
>;
const trackedMutationSchema = z
  .object({
    id: z.string().min(1).max(512),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fieldRevisions: canonicalFieldRevisionsSchema,
  })
  .strict();
const canonicalGroups = {
  notes: [
    "notes",
    "notesVersion",
    "notesDelta",
    "notesHistory",
    "notesLastEditedBy",
    "notesLastEditedAt",
    "suggestionsHistory",
  ],
  meetingName: ["meetingName"],
  summarySentence: ["summarySentence"],
  summaryLabel: ["summaryLabel"],
} as const;

export function validateCanonicalFieldRevisions(
  raw: Record<string, unknown>,
): void {
  const mutation = raw.contentMutation;
  if (
    !mutation ||
    typeof mutation !== "object" ||
    !("fieldRevisions" in mutation)
  )
    return;
  const parsed = trackedMutationSchema.parse(mutation);
  const current = revision.parse(raw.contentRevision);
  if (Object.values(parsed.fieldRevisions).some((value) => value > current))
    throw new Error("Canonical field revision exceeds content revision");
}

export function nextCanonicalFieldRevisions(
  history: MeetingHistory,
  changes: readonly (
    | Exclude<MeetingUpdateMutation, { kind: "correction" | "regeneration" }>
    | Extract<MeetingUpdateMutation, { kind: "correction" }>["changes"][number]
  )[],
  nextRevision: number,
): { fieldRevisions?: CanonicalFieldRevisions } {
  const previous = history.contentMutation?.fieldRevisions;
  if ((history.contentRevision ?? 0) > 0 && !previous) return {};
  const fieldRevisions = { ...previous };
  for (const change of changes) {
    if (change.kind === "notes") fieldRevisions.notes = nextRevision;
    if (change.kind === "rename") fieldRevisions.meetingName = nextRevision;
    if (change.kind === "summarySentence")
      fieldRevisions.summarySentence = nextRevision;
    if (change.kind === "summaryLabel")
      fieldRevisions.summaryLabel = nextRevision;
  }
  return { fieldRevisions };
}

/** Undefined means an older in-flight generation cannot prove which fields changed. */
export function canonicalFieldsSupersededAfter(
  row: MeetingHistory,
  baseline: number,
): ReadonlySet<string> | undefined {
  if ((row.contentRevision ?? 0) <= baseline) return new Set();
  const revisions = row.contentMutation?.fieldRevisions;
  if (!revisions) return undefined;
  const fields = new Set<string>();
  for (const group of Object.keys(
    canonicalGroups,
  ) as (keyof typeof canonicalGroups)[])
    if ((revisions[group] ?? 0) > baseline)
      for (const field of canonicalGroups[group]) fields.add(field);
  return fields;
}

/** Keep the caller's original completion authority; replace only acknowledged canonical content. */
export function originalCompletionExportView(
  original: MeetingHistory,
  committed: MeetingHistory,
): MeetingHistory {
  const next = { ...original };
  for (const fields of Object.values(canonicalGroups))
    for (const field of fields) {
      // All values originate from the acknowledged canonical row, including absence.
      Object.assign(next, { [field]: committed[field] });
    }
  return next;
}
