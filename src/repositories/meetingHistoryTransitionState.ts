import { convertToNative, marshall } from "@aws-sdk/util-dynamodb";
import type { MeetingHistory } from "../types/db";
import type { HistoryTransition } from "../types/meetingHistoryTransition";
import {
  matchesPublicationSnapshot,
  publicationSnapshot,
  settledLifecycleDelivery,
} from "../types/meetingPublication";
import { MEETING_UPDATE_DELIVERY_QUEUE } from "../types/meetingUpdateDelivery";

function matchesExecution(
  row: MeetingHistory | undefined,
  input: HistoryTransition,
): row is MeetingHistory {
  return (
    row !== undefined &&
    row.meetingId === input.expectedMeetingId &&
    row.ownerInstanceId === input.expectedOwnerInstanceId &&
    row.executionVersion === input.expectedExecutionVersion &&
    row.status === input.expectedStatus
  );
}
export function matchesOwnedHistoryTransition(
  row: MeetingHistory | undefined,
  input: HistoryTransition,
): row is MeetingHistory {
  return (
    matchesExecution(row, input) &&
    (!input.expectedPublication ||
      matchesPublicationSnapshot(row, input.expectedPublication)) &&
    (input.expectedCheckpointRevision === undefined ||
      (row.checkpoint?.revision ?? 0) === input.expectedCheckpointRevision)
  );
}
/** Called only after the owning database transaction has acknowledged this exact patch. */
export function publicationHistoryAfterPatch(
  row: MeetingHistory,
  patch: Partial<MeetingHistory>,
): MeetingHistory {
  const settled = settledLifecycleDelivery(publicationSnapshot(row), patch);
  patch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const next: MeetingHistory = {
    ...row,
    ...patch,
    ...(settled
      ? {
          updateDelivery: settled.delivery,
          ...(settled.dueAt === undefined
            ? {}
            : {
                updateDeliveryQueue: MEETING_UPDATE_DELIVERY_QUEUE,
                updateDeliveryDueAt: settled.dueAt,
              }),
        }
      : {}),
  };
  return convertToNative({
    M: marshall(next, { removeUndefinedValues: true }),
  });
}
export function applyMockOwnedHistoryTransition(
  row: MeetingHistory,
  input: HistoryTransition,
): void {
  const patch: HistoryTransition["patch"] = {};
  for (const [field, value] of Object.entries(input.patch))
    if (value !== undefined)
      Object.assign(patch, { [field]: structuredClone(value) });
  Object.assign(
    row,
    input.expectedPublication
      ? publicationHistoryAfterPatch(row, patch)
      : { ...row, ...patch },
  );
}
