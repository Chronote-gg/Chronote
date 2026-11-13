import { notesDeliveryTimingSchema } from "./meetingNotesTiming";
import { completionPolicySchema } from "./meetingCompletionPolicy";
import {
  recordingCheckpointSchema,
  recordingCaptureStateSchema,
  captureCoverageSummarySchema,
  recoveryDispositionSchema,
} from "./recordingCheckpoint";
import { z } from "zod";
import type { MeetingHistory } from "./db";
import { MEETING_STATUS, type MeetingStatus } from "./meetingLifecycle";

const id = z.string().min(1);
const epochSecond = z.number().int().nonnegative();

export type ControlTableNames = {
  deploymentControl: string;
  meetingHistory: string;
  activeMeeting?: string;
  personalMediaUpload?: string;
};
export type SessionReservation = {
  timingReceipt?: { reservedAt: number; monotonicMilliseconds: number };
  guildId: string;
  meetingId: string;
  ownerInstanceId: string;
  executionVersion: number;
  voiceOperationAttemptId: string;
  reservedAt: number;
} & (
  | { sessionMode: "meeting"; historyKey: HistoryKey }
  | { sessionMode: "tts_only"; historyKey?: never }
);
export type SessionAdmissionResult =
  | { kind: "admitted"; reservation: SessionReservation }
  | { kind: "blocked"; reason: "active_session" | "suppressed" };
export type SessionOwnership = Pick<
  SessionReservation,
  | "guildId"
  | "meetingId"
  | "ownerInstanceId"
  | "executionVersion"
  | "voiceOperationAttemptId"
>;
export type HistoryKey = Pick<
  MeetingHistory,
  "guildId" | "channelId_timestamp"
>;
const HISTORY_TRANSITION_FIELDS = [
  "completionPolicy",
  "checkpoint",
  "capture",
  "captureCoverage",
  "recovery",
  "status",
  "duration",
  "endReason",
  "endTriggeredByUserId",
  "cancellationReason",
  "processing",
  "delivery",
  "updatedAt",
  "transcriptS3Key",
  "audioS3Key",
  "chatS3Key",
  "notes",
  "meetingName",
  "summarySentence",
  "summaryLabel",
  "context",
  "participants",
  "tags",
  "summaryMessageId",
  "notesMessageIds",
  "notesChannelId",
  "notesDeliveryTiming",
  "notesVersion",
  "notesLastEditedBy",
  "notesLastEditedAt",
  "notesHistory",
  "startMessageId",
] as const;
export type CheckpointPublication = {
  kind: "checkpoint_publication";
  ownership: SessionOwnership & { sessionMode: "meeting" };
  now: number;
};
export type HistoryTransition = {
  expectedPublication?: import("./meetingPublication").MeetingPublicationSnapshot;
  completionPolicyProof?: {
    kind: "completion_policy";
    ownership: CheckpointPublication["ownership"];
    now: number;
  };
  checkpointPublication?: CheckpointPublication;
  signal?: AbortSignal;
  expectedCheckpointRevision?: number;
  key: HistoryKey;
  expectedMeetingId: string;
  expectedOwnerInstanceId: string;
  expectedExecutionVersion: number;
  expectedStatus: MeetingStatus;
  patch: Partial<
    Pick<MeetingHistory, (typeof HISTORY_TRANSITION_FIELDS)[number]>
  >;
};
const legalTransitions: Record<MeetingStatus, readonly MeetingStatus[]> = {
  starting: ["in_progress", "processing", "interrupted", "failed", "cancelled"],
  in_progress: ["processing", "interrupted", "failed", "cancelled"],
  processing: ["processing", "complete", "interrupted", "failed", "cancelled"],
  interrupted: ["processing", "failed"],
  failed: [],
  complete: [],
  cancelled: ["cancelled"],
};
export function validateHistoryTransition(input: HistoryTransition): void {
  id.parse(input.key.guildId);
  id.parse(input.key.channelId_timestamp);
  id.parse(input.expectedMeetingId);
  id.parse(input.expectedOwnerInstanceId);
  z.number().int().positive().parse(input.expectedExecutionVersion);
  z.enum(MEETING_STATUS).parse(input.expectedStatus);
  for (const key of Object.keys(input.patch)) {
    if (!HISTORY_TRANSITION_FIELDS.some((field) => field === key))
      throw new Error("History transition field is not allowed");
  }
  if (!Object.values(input.patch).some((value) => value !== undefined))
    throw new Error("History transition patch is empty");
  validateCompletionPolicyTransition(input);
  validateCheckpointTransition(input);
  if (input.patch.capture)
    recordingCaptureStateSchema.parse(input.patch.capture);
  if (input.patch.captureCoverage)
    captureCoverageSummarySchema.parse(input.patch.captureCoverage);
  if (input.patch.recovery)
    recoveryDispositionSchema.parse(input.patch.recovery);
  if (input.patch.notesDeliveryTiming !== undefined)
    notesDeliveryTimingSchema.parse(input.patch.notesDeliveryTiming);
  if (input.checkpointPublication) validateCheckpointPublication(input);
  const target = input.patch.status;
  if (target && !legalTransitions[input.expectedStatus].includes(target))
    throw new Error("Illegal history status transition");
}

function validateCompletionPolicyTransition(input: HistoryTransition) {
  if (input.patch.completionPolicy && !input.completionPolicyProof)
    throw new Error("Completion policy requires original-owner proof");
  if (input.patch.completionPolicy)
    completionPolicySchema.parse(input.patch.completionPolicy);
  if (input.completionPolicyProof) {
    const proof = input.completionPolicyProof;
    if (
      proof.kind !== "completion_policy" ||
      proof.ownership.sessionMode !== "meeting"
    )
      throw new Error("Completion policy requires recording authority");
    id.parse(proof.ownership.voiceOperationAttemptId);
    epochSecond.parse(proof.now);
    z.number().int().nonnegative().parse(input.expectedCheckpointRevision);
    if (input.checkpointPublication)
      throw new Error("Conflicting completion authority");
    validateCompletionPolicyIdentity(input);
    if (
      input.patch.status &&
      (input.patch.status !== "cancelled" ||
        input.patch.completionPolicy?.decision !== "cancel")
    )
      throw new Error("Completion policy status must encode cancellation");
  }
}
function validateCompletionPolicyIdentity(input: HistoryTransition) {
  const proof = input.completionPolicyProof!;
  if (
    !input.signal ||
    proof.ownership.guildId !== input.key.guildId ||
    proof.ownership.meetingId !== input.expectedMeetingId ||
    proof.ownership.ownerInstanceId !== input.expectedOwnerInstanceId ||
    proof.ownership.executionVersion !== input.expectedExecutionVersion ||
    !input.patch.completionPolicy ||
    Object.keys(input.patch).some(
      (key) =>
        ![
          "completionPolicy",
          "status",
          "endReason",
          "cancellationReason",
        ].includes(key),
    )
  )
    throw new Error("Completion policy requires exact original authority");
}
function validateCheckpointPublication(input: HistoryTransition) {
  const proof = input.checkpointPublication!;
  const owner = proof.ownership;
  id.parse(owner.voiceOperationAttemptId);
  epochSecond.parse(proof.now);
  z.number().int().nonnegative().parse(input.expectedCheckpointRevision);
  if (
    proof.kind !== "checkpoint_publication" ||
    !input.signal ||
    Object.keys(input.patch).some(
      (field) => !["checkpoint", "updatedAt"].includes(field),
    ) ||
    owner.guildId !== input.key.guildId ||
    owner.meetingId !== input.expectedMeetingId ||
    owner.ownerInstanceId !== input.expectedOwnerInstanceId ||
    owner.executionVersion !== input.expectedExecutionVersion ||
    owner.sessionMode !== "meeting"
  )
    throw new Error(
      "Checkpoint publication requires original session authority and metadata only",
    );
}

function validateCheckpointTransition(input: HistoryTransition) {
  if (input.patch.checkpoint) {
    if (
      !["starting", "in_progress", "processing"].includes(input.expectedStatus)
    )
      throw new Error("Terminal capture cannot publish checkpoints");
    const checkpoint = recordingCheckpointSchema.parse(input.patch.checkpoint);
    const expectedRevision = z
      .number()
      .int()
      .nonnegative()
      .parse(input.expectedCheckpointRevision);
    if (
      checkpoint.revision !== expectedRevision + 1 ||
      checkpoint.capture.meetingId !== input.expectedMeetingId ||
      checkpoint.capture.ownerInstanceId !== input.expectedOwnerInstanceId ||
      checkpoint.capture.executionVersion !== input.expectedExecutionVersion ||
      checkpoint.capture.guildId !== input.key.guildId ||
      checkpoint.capture.channelId_timestamp !== input.key.channelId_timestamp
    )
      throw new Error("Checkpoint capture ownership or revision mismatch");
  }
}
