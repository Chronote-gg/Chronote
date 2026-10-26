import { stableJson } from "../utils/stableJson";
import { isDeepStrictEqual } from "node:util";
import type { MeetingHistory } from "../types/db";
import {
  meetingUpdateDeliverySchema,
  presentationPartSchema,
} from "../types/meetingUpdateDelivery";
import {
  initialMeetingUpdatePolicy,
  PUBLICATION_SNAPSHOT_FIELDS,
} from "../types/meetingPublication";
import { canonicalFieldsSupersededAfter } from "../types/meetingCanonicalContent";

export const MAX_RECORDING_CANONICAL_TRANSITION_ATTEMPTS = 3;

function canonicalDeliveryAdvanced(
  previous: MeetingHistory,
  current: MeetingHistory,
): boolean {
  const before = previous.updateDelivery;
  const after = current.updateDelivery;
  if (!after) return !before;
  const expected =
    before ??
    meetingUpdateDeliverySchema.parse({
      revision: after.revision,
      policy: initialMeetingUpdatePolicy(previous),
      parts: after.parts,
      progress: {
        kind: "pending",
        nextCheckAt:
          "nextCheckAt" in after.progress ? after.progress.nextCheckAt : 0,
      },
    });
  // Content requests may advance desired parts, never publication authority or receipts.
  return (
    stableJson({
      ...expected,
      revision: after.revision,
      parts: after.parts,
    }) === stableJson(after) &&
    presentationPartSchema.options.every(
      (part) =>
        after.parts[part].acknowledged ===
          (before?.parts[part].acknowledged ?? 0) &&
        after.parts[part].desired >= (before?.parts[part].desired ?? 0) &&
        after.parts[part].desired <= (current.contentRevision ?? 0),
    )
  );
}

export function canonicalContentAdvanced(
  previous: MeetingHistory,
  current: MeetingHistory,
): boolean {
  const baseline = previous.contentRevision ?? 0;
  if ((current.contentRevision ?? 0) <= baseline) return false;
  const changed = canonicalFieldsSupersededAfter(current, baseline);
  if (!changed || !canonicalDeliveryAdvanced(previous, current)) return false;
  const canonicalFields = new Set([
    ...changed,
    "contentRevision",
    "contentMutation",
    "updateDelivery",
  ]);
  return PUBLICATION_SNAPSHOT_FIELDS.every(
    (field) =>
      canonicalFields.has(field) ||
      isDeepStrictEqual(previous[field], current[field]),
  );
}
