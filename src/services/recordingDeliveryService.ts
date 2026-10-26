import {
  canonicalContentAdvanced,
  MAX_RECORDING_CANONICAL_TRANSITION_ATTEMPTS,
} from "./recordingCanonicalConflict";
import { publicationSnapshot } from "../types/meetingPublication";
import { isDeepStrictEqual } from "node:util";
import { getDeploymentControlRepository } from "../db";
import type { MeetingData } from "../types/meeting-data";
import type { MeetingHistory } from "../types/db";
import {
  RECORDING_DELIVERY_FIELDS,
  type HistoryTransition,
  type RecordingDeliveryProof,
  type SessionReservation,
} from "../types/deploymentControl";
import {
  notesDeliveryTimingSchema,
  type NotesDeliveryTiming,
} from "../types/meetingNotesTiming";
import type { RecoveryDisposition } from "../types/recordingCheckpoint";
import { getMeetingProcessingSignal } from "./meetingProcessingLifetime";

type RecordingReservation = Extract<
  SessionReservation,
  { sessionMode: "meeting" }
>;
type Delivery = {
  original: RecordingReservation;
  signal: AbortSignal;
  messagesComplete: boolean;
  intentAcknowledged: boolean;
  writing: boolean;
};
const deliveries = new WeakMap<MeetingData, Delivery>();
function owner(meeting: MeetingData): Delivery {
  const delivery = deliveries.get(meeting);
  if (!delivery?.intentAcknowledged)
    throw new Error("Recording delivery intent is not acknowledged");
  delivery.signal.throwIfAborted();
  return delivery;
}
function marker(original: RecordingReservation): RecoveryDisposition {
  return {
    disposition: "needs_reconciliation",
    reason: "delivery_uncertain",
    stage: "delivery",
    attempt: 0,
    executionVersion: original.executionVersion,
    retry: { maxAttempts: 3, nextAttemptAt: null },
  };
}
async function readOwned(delivery: Delivery): Promise<MeetingHistory> {
  delivery.signal.throwIfAborted();
  const row = await getDeploymentControlRepository().getMeetingHistory(
    delivery.original.historyKey,
    delivery.signal,
  );
  delivery.signal.throwIfAborted();
  if (
    !row ||
    row.meetingId !== delivery.original.meetingId ||
    row.ownerInstanceId !== delivery.original.ownerInstanceId ||
    row.executionVersion !== delivery.original.executionVersion ||
    !row.checkpoint
  )
    throw new Error("Recording delivery history ownership changed");
  return row;
}
function snapshot(row: MeetingHistory): RecordingDeliveryProof["previous"] {
  return {
    recovery: row.recovery,
    summaryMessageId: row.summaryMessageId,
    notesMessageIds: row.notesMessageIds,
    notesChannelId: row.notesChannelId,
    notesDeliveryTiming: row.notesDeliveryTiming,
  };
}
async function commitMetadata(
  delivery: Delivery,
  row: MeetingHistory,
  phase: RecordingDeliveryProof["phase"],
  patch: HistoryTransition["patch"],
) {
  delivery.signal.throwIfAborted();
  const transition: HistoryTransition = {
    expectedPublication: publicationSnapshot(row),
    key: delivery.original.historyKey,
    expectedMeetingId: delivery.original.meetingId,
    expectedOwnerInstanceId: delivery.original.ownerInstanceId,
    expectedExecutionVersion: delivery.original.executionVersion,
    expectedStatus: row.status!,
    expectedCheckpointRevision: row.checkpoint!.revision,
    recordingDelivery: {
      kind: "recording_delivery",
      phase,
      ownership: delivery.original,
      now: Math.floor(Date.now() / 1000),
      previous: snapshot(row),
    },
    patch,
    signal: delivery.signal,
  };
  let committed;
  try {
    committed =
      await getDeploymentControlRepository().transitionMeetingHistory(
        transition,
      );
  } catch (error) {
    // An uncertain intent acknowledgment must never initiate a remote mutation.
    if (phase === "intent") throw error;
    const readback = await readOwned(delivery);
    if (
      readback.status !== row.status ||
      readback.checkpoint?.revision !== row.checkpoint?.revision ||
      !RECORDING_DELIVERY_FIELDS.every(
        (field) =>
          patch[field] === undefined ||
          isDeepStrictEqual(
            JSON.parse(JSON.stringify(readback[field] ?? null)),
            JSON.parse(JSON.stringify(patch[field])),
          ),
      )
    )
      throw error;
    committed = "applied";
  }
  delivery.signal.throwIfAborted();

  return committed;
}
async function write(
  delivery: Delivery,
  row: MeetingHistory,
  phase: RecordingDeliveryProof["phase"],
  patch: HistoryTransition["patch"],
) {
  if (delivery.writing)
    throw new Error("Recording delivery metadata write already owned");
  delivery.writing = true;
  const originalPatch = { ...patch, updatedAt: new Date().toISOString() };
  try {
    let current = row;
    for (
      let attempt = 0;
      attempt < MAX_RECORDING_CANONICAL_TRANSITION_ATTEMPTS;
      attempt++
    ) {
      const result = await commitMetadata(
        delivery,
        current,
        phase,
        originalPatch,
      );
      if (result === "applied") return;
      if (
        result !== "stale" ||
        attempt + 1 === MAX_RECORDING_CANONICAL_TRANSITION_ATTEMPTS
      )
        break;
      const next = await readOwned(delivery);
      if (!canonicalContentAdvanced(current, next)) break;
      current = next;
    }
    throw new Error("Recording delivery metadata was fenced");
  } finally {
    delivery.writing = false;
  }
}
export async function beginRecordingDelivery(
  meeting: MeetingData,
): Promise<void> {
  if (deliveries.has(meeting))
    throw new Error("Recording delivery already attempted");
  const reservation = meeting.reservation;
  if (reservation?.sessionMode !== "meeting")
    throw new Error("Recording delivery requires original meeting reservation");
  const delivery: Delivery = {
    original: { ...reservation, historyKey: { ...reservation.historyKey } },
    signal: getMeetingProcessingSignal(meeting),
    messagesComplete: false,
    intentAcknowledged: false,
    writing: false,
  };
  deliveries.set(meeting, delivery);
  const row = await readOwned(delivery);
  if (
    row.publicationRepair?.kind === "running" ||
    (row.updateDelivery && "attempt" in row.updateDelivery.progress) ||
    row.status !== "processing" ||
    row.recovery?.stage === "delivery"
  )
    throw new Error("Recording delivery cannot be replayed");
  await write(delivery, row, "intent", { recovery: marker(delivery.original) });
  delivery.intentAcknowledged = true;
}
export async function acknowledgeRecordingDeliveryMessage(
  meeting: MeetingData,
  phase: "summary" | "notes",
  messageId: string,
  notesTiming?: NotesDeliveryTiming,
): Promise<void> {
  const delivery = owner(meeting);
  const row = await readOwned(delivery);
  const patch: HistoryTransition["patch"] = {
    recovery: marker(delivery.original),
  };
  if (phase === "summary") {
    patch.summaryMessageId = messageId;
    meeting.summaryMessageId = messageId;
  } else {
    const timing = notesDeliveryTimingSchema.safeParse(notesTiming);
    if (timing.success) {
      patch.notesDeliveryTiming = timing.data;
      meeting.notesDeliveryTiming = timing.data;
    }
    patch.notesMessageIds = [
      ...new Set([...(row.notesMessageIds ?? []), messageId]),
    ];
    patch.notesChannelId = meeting.textChannel.id;
    meeting.notesMessageIds = patch.notesMessageIds;
    meeting.notesChannelId = patch.notesChannelId;
  }
  await write(delivery, row, "acknowledgment", patch);
}
export function finishRecordingDeliveryMutations(meeting: MeetingData): void {
  owner(meeting).messagesComplete = true;
}
export async function acknowledgeRecordingDeliveryHistory(
  meeting: MeetingData,
): Promise<void> {
  const delivery = owner(meeting);
  if (!delivery.messagesComplete)
    throw new Error("Recording delivery mutations remain unresolved");
  const row = await readOwned(delivery);
  if (
    row.status !== "complete" ||
    row.summaryMessageId !== meeting.summaryMessageId ||
    JSON.stringify(row.notesMessageIds) !==
      JSON.stringify(meeting.notesMessageIds) ||
    row.notesChannelId !== meeting.notesChannelId
  )
    throw new Error("Recording delivery terminal history is not acknowledged");
  await write(delivery, row, "acknowledgment", {
    recovery: {
      disposition: "done",
      outcome: "completed",
      stage: "delivery",
      attempt: 0,
      executionVersion: delivery.original.executionVersion,
      retry: { maxAttempts: 3, nextAttemptAt: null },
    },
  });
}
