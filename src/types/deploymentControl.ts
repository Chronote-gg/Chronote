import {
  fixtureInputEvidenceSchema,
  fixtureGenerationSchema,
  fixtureTranscriptSchema,
} from "./fixtureEvidence";
import {
  maintenanceHoldSchema,
  fixtureGrantSchema,
  introductionHoldSchema,
  type NewWorkScope,
} from "./productionIntroduction";
import { notesDeliveryTimingSchema } from "./meetingNotesTiming";
import { completionPolicySchema } from "./meetingCompletionPolicy";
import {
  recordingCheckpointSchema,
  recordingCaptureStateSchema,
  captureCoverageSummarySchema,
  recoveryDispositionSchema,
} from "./recordingCheckpoint";
import { z } from "zod";
import type { ActiveMeetingLease, MeetingHistory } from "./db";
import { MEETING_STATUS, type MeetingStatus } from "./meetingLifecycle";

const id = z.string().min(1);
const epochSecond = z.number().int().nonnegative();
const generation = z.number().int().nonnegative();
const identityFields = { instanceId: id, protocolVersion: z.literal(1) };
const runtimeModeSchema = z.enum(["bot", "api", "all"]);
export const runtimeIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({ ...identityFields, kind: z.literal("local"), localId: id })
    .strict(),
  z
    .object({
      ...identityFields,
      kind: z.literal("ecs"),
      taskArn: id,
      imageDigest: id,
      candidateId: id,
    })
    .strict(),
]);
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
export const runtimeReadinessSchema = z
  .object({
    identity: runtimeIdentitySchema,
    runtimeMode: runtimeModeSchema,
    observedEpoch: generation,
    observedGeneration: generation,
    gatewayReady: z.boolean(),
    cacheReady: z.boolean(),
    dependenciesReady: z.boolean(),
    provenAt: epochSecond,
    expiresAt: epochSecond,
  })
  .strict();
export type RuntimeReadiness = z.infer<typeof runtimeReadinessSchema>;
export const protectionConfirmationSchema = z
  .object({
    identity: runtimeIdentitySchema,
    provenAt: epochSecond,
    expiresAt: epochSecond,
  })
  .strict();
export type ProtectionConfirmation = z.infer<
  typeof protectionConfirmationSchema
>;
export const RUNTIME_WORK_KINDS = [
  "pending_admission",
  "recording",
  "finalization",
  "personal_processing",
  "recovery_processing",
  "voice_operation",
  "ancillary_delivery",
] as const;
export type RuntimeWorkKind = (typeof RUNTIME_WORK_KINDS)[number];
export type RuntimeWorkHandle = { settle(): void };

export type SessionOwnership = Pick<
  SessionReservation,
  | "guildId"
  | "meetingId"
  | "ownerInstanceId"
  | "executionVersion"
  | "voiceOperationAttemptId"
>;
export type WorkAdmissionAuthority =
  | { kind: "serving"; context: AdmissionContext }
  | { kind: "session"; ownership: SessionOwnership; now: number };
const runtimeMembersSchema = z
  .array(runtimeIdentitySchema)
  .max(98)
  .refine(
    (members) =>
      new Set(members.map((member) => member.instanceId)).size ===
      members.length,
    "Runtime members must be unique",
  );
export const retirementRequestSchema = z
  .object({
    identity: runtimeIdentitySchema,
    authorizedGeneration: generation,
    coordinatorToken: id,
    coordinatorEpoch: generation,
  })
  .strict();
export type RetirementRequest = z.infer<typeof retirementRequestSchema>;
const retirementAcknowledgmentSchema = z
  .object({
    request: retirementRequestSchema,
    retiredAt: epochSecond,
  })
  .strict();
export type RetirementAcknowledgment = z.infer<
  typeof retirementAcknowledgmentSchema
>;
const deploymentText = z.string().min(1).max(1024);
const deploymentRoutingSchema = z
  .object({
    listenerArn: deploymentText,
    sourceGroup: deploymentText,
    candidateGroup: deploymentText,
    containerName: deploymentText,
    containerPort: z.number().int().positive(),
    sourceRevision: deploymentText,
    candidateRevision: deploymentText.optional(),
    state: z.enum([
      "source",
      "forward_submitted",
      "candidate",
      "rollback_submitted",
      "rolled_back",
    ]),
  })
  .strict();
export const deploymentPhaseSchema = z
  .object({
    runToken: deploymentText,
    cluster: deploymentText,
    service: deploymentText,
    family: deploymentText,
    tablePrefix: deploymentText,
    candidateId: deploymentText,
    image: deploymentText,
    runtimeMode: runtimeModeSchema,
    phase: z.enum([
      "preparing",
      "warming",
      "promoting",
      "promoted",
      "retiring",
      "complete",
      "rollback_promoting",
      "rolled_back",
    ]),
    originalGeneration: generation,
    originalMembers: runtimeMembersSchema,
    outgoing: runtimeIdentitySchema,
    previousTaskDefinition: deploymentText,
    routing: deploymentRoutingSchema.optional(),
    taskDefinition: deploymentText.optional(),
    candidate: runtimeIdentitySchema.optional(),
    updatedAt: epochSecond,
  })
  .strict();
export type DeploymentPhase = z.infer<typeof deploymentPhaseSchema>;
const workCountsSchema = z.record(
  z.enum(RUNTIME_WORK_KINDS),
  z.number().int().nonnegative(),
);
/** Coordinator record for an outgoing runtime whose ECS task stopped before acknowledging retirement. */
export const retirementContinuationSchema = z
  .object({
    reason: z.literal("outgoing_task_stopped"),
    taskStatus: z.enum(["stopped", "missing"]),
    stoppedReason: deploymentText.optional(),
    stoppedAt: z.string().datetime({ offset: true }).optional(),
    lostWorkCounts: workCountsSchema.optional(),
    continuedBy: deploymentText,
    continuedAt: epochSecond,
  })
  .strict();
export type RetirementContinuation = z.infer<
  typeof retirementContinuationSchema
>;
export const controlRecordSchema = z
  .object({
    pk: z.literal("ENV"),
    sk: z.literal("CONTROL"),
    recordType: z.literal("control"),
    runtimeEnvironment: z.enum(["local", "ecs"]),
    protocolVersion: z.literal(1),
    coordinatorToken: id,
    coordinatorEpoch: generation,
    coordinatorExpiresAt: epochSecond,
    servingGeneration: generation,
    recoveryScanCursor: z
      .object({ guildId: id, channelId_timestamp: id })
      .strict()
      .optional(),
    maintenance: maintenanceHoldSchema.optional(),
    deployment: deploymentPhaseSchema.optional(),
    compatibleReplacement: z
      .object({
        runToken: id,
        servingGeneration: generation,
        servingMembers: z.record(z.string(), runtimeIdentitySchema),
      })
      .strict()
      .optional(),
    servingMembers: z
      .record(z.string(), runtimeIdentitySchema)
      .refine(
        (members) =>
          Object.keys(members).length <= 98 &&
          Object.entries(members).every(
            ([instanceId, identity]) => instanceId === identity.instanceId,
          ),
        "Serving membership must bind instance keys to exact identities",
      ),
  })
  .strict()
  .refine(
    (row) =>
      Object.values(row.servingMembers).every(
        (member) => member.kind === row.runtimeEnvironment,
      ),
    "Control environment must match every serving identity",
  );
export type ControlRecord = z.infer<typeof controlRecordSchema>;
export const runtimeRecordSchema = z
  .object({
    pk: z.literal("ENV"),
    sk: id,
    recordType: z.literal("runtime"),
    identity: runtimeIdentitySchema,
    role: z.enum([
      "candidate",
      "serving",
      "draining",
      "releasing",
      "retired",
      "stale",
    ]),
    authorizedGeneration: generation,
    heartbeatAt: epochSecond,
    canonicalContentWriter: z.literal(1).optional(),
    readiness: runtimeReadinessSchema,
    protection: protectionConfirmationSchema,
    workCounts: workCountsSchema.optional(),
    expiresAt: epochSecond.optional(),
    retirementRequest: retirementRequestSchema.optional(),
    retirementAcknowledgment: retirementAcknowledgmentSchema.optional(),
    retirementContinuation: retirementContinuationSchema.optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.sk !== `RUNTIME#${row.identity.instanceId}`)
      ctx.addIssue({
        code: "custom",
        message: "Runtime key does not match identity",
      });
    if (
      !sameRuntimeIdentity(row.identity, row.readiness.identity) ||
      !sameRuntimeIdentity(row.identity, row.protection.identity)
    )
      ctx.addIssue({
        code: "custom",
        message: "Runtime proofs must bind to the exact identity",
      });
    if (row.expiresAt !== undefined && row.role !== "stale")
      ctx.addIssue({
        code: "custom",
        message: "Only stale runtime rows receive TTL",
      });
  });
export type RuntimeRecord = z.infer<typeof runtimeRecordSchema>;
export type LocalBootstrapInput = {
  control: ControlRecord;
  candidate: RuntimeRecord;
  members: RuntimeRecord[];
  now: number;
};
export type RuntimeRoleTransition = {
  record: RuntimeRecord;
  expectedRole: RuntimeRecord["role"];
  expectedGeneration: number;
  retirementEpoch: number;
  expectedRetirementRequest?: RetirementRequest;
  expectedRetirementAcknowledgment?: RetirementAcknowledgment;
};
export type StoppedOutgoingContinuationInput = {
  control: ControlRecord;
  outgoing: RuntimeRecord;
  continuation: RetirementContinuation;
  now: number;
};
export type RuntimeRetirementRequestInput = {
  record: RuntimeRecord;
  request: RetirementRequest;
  now: number;
};
export function validateRuntimeRoleTransition(
  input: RuntimeRoleTransition,
): void {
  runtimeRecordSchema.parse(input.record);
  generation.parse(input.expectedGeneration);
  generation.parse(input.retirementEpoch);
  const legal =
    (input.record.role === "draining" &&
      ["candidate", "serving"].includes(input.expectedRole)) ||
    (input.record.role === "releasing" && input.expectedRole === "draining") ||
    (input.record.role === "retired" && input.expectedRole === "releasing") ||
    (input.record.role === "candidate" && input.expectedRole === "retired");
  if (!legal || input.record.authorizedGeneration !== input.expectedGeneration)
    throw new Error("Invalid runtime role transition");
}
export const voiceRecordSchema = z
  .object({
    pk: id,
    sk: z.literal("STATE"),
    recordType: z.literal("voice"),
    protocolVersion: z.literal(1),
    guildId: id,
    meetingId: id,
    ownerInstanceId: id,
    attemptId: id,
    executionVersion: z.number().int().positive().optional(),
    sessionMode: z.enum(["meeting", "tts_only"]).optional(),
    state: z.enum([
      "joining",
      "connected",
      "disconnecting",
      "uncertain",
      "settled",
    ]),
    updatedAt: epochSecond,
  })
  .strict()
  .refine(
    (row) => row.pk === `VOICE#${row.guildId}`,
    "Voice key does not match guild",
  );
export type VoiceRecord = z.infer<typeof voiceRecordSchema>;
export const suppressionRecordSchema = z
  .object({
    pk: id,
    sk: id,
    recordType: z.literal("suppression"),
    protocolVersion: z.literal(1),
    guildId: id,
    channelId: id,
    meetingId: id,
    createdAt: epochSecond,
    version: z.number().int().positive(),
    suppressed: z.boolean(),
    reason: z.enum(["explicit_end", "forced_disconnect"]),
  })
  .strict()
  .refine(
    (row) =>
      row.pk === `SUPPRESS#${row.guildId}` &&
      row.sk === `CHANNEL#${row.channelId}`,
    "Suppression key does not match scope",
  );
export type SuppressionRecord = z.infer<typeof suppressionRecordSchema>;
export const pausedDesktopDraftKey = (uploadId: string) => ({
  pk: `UPLOAD#${id.parse(uploadId)}`,
  sk: "PAUSED_DRAFT",
});
export const pausedDesktopDraftRecordSchema = z
  .object({
    pk: id,
    sk: z.literal("PAUSED_DRAFT"),
    recordType: z.literal("paused_desktop_draft"),
    protocolVersion: z.literal(1),
    uploadId: id,
    ownerUserId: id,
    operationId: id,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    preservedCaptureSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: epochSecond,
  })
  .strict()
  .refine(
    (row) => row.pk === pausedDesktopDraftKey(row.uploadId).pk,
    "Paused draft key does not match upload",
  );
export type PausedDesktopDraftRecord = z.infer<
  typeof pausedDesktopDraftRecordSchema
>;
export const deploymentControlRecordSchema = z.union([
  controlRecordSchema,
  runtimeRecordSchema,
  voiceRecordSchema,
  suppressionRecordSchema,
  fixtureGrantSchema,
  introductionHoldSchema,
  pausedDesktopDraftRecordSchema,
]);
export type DeploymentControlRecord = z.infer<
  typeof deploymentControlRecordSchema
>;
export const parseDeploymentControlRecord = (
  value: unknown,
): DeploymentControlRecord => deploymentControlRecordSchema.parse(value);

export function sameRuntimeIdentity(
  a: RuntimeIdentity,
  b: RuntimeIdentity,
): boolean {
  if (
    a.kind !== b.kind ||
    a.instanceId !== b.instanceId ||
    a.protocolVersion !== b.protocolVersion
  )
    return false;
  if (a.kind === "local" && b.kind === "local") return a.localId === b.localId;
  return (
    a.kind === "ecs" &&
    b.kind === "ecs" &&
    a.taskArn === b.taskArn &&
    a.imageDigest === b.imageDigest &&
    a.candidateId === b.candidateId
  );
}

export const admissionContextSchema = z
  .object({
    instanceId: id,
    identity: runtimeIdentitySchema,
    authorizedGeneration: generation,
    observedEpoch: generation,
    protocolVersion: z.literal(1),
    now: epochSecond,
    maintenance: maintenanceHoldSchema.optional(),
  })
  .strict()
  .refine(
    (context) => context.instanceId === context.identity.instanceId,
    "Admission identity mismatch",
  );
export type AdmissionContext = z.infer<typeof admissionContextSchema>;
export type ControlTableNames = {
  deploymentControl: string;
  meetingHistory: string;
  activeMeeting?: string;
  personalMediaUpload?: string;
};
export type PausedDesktopDraftInstallation = {
  control: ControlRecord;
  coordinatorToken: string;
  coordinatorEpoch: number;
  now: number;
  pairs: readonly [
    {
      record: PausedDesktopDraftRecord;
      expectedParent: import("./db").PersonalMediaUploadJobRecord;
    },
    {
      record: PausedDesktopDraftRecord;
      expectedParent: import("./db").PersonalMediaUploadJobRecord;
    },
  ];
};
export type SessionReservationInput = {
  scope?: NewWorkScope;
  context: AdmissionContext;
  lease: ActiveMeetingLease & {
    executionVersion: number;
    sessionMode: "meeting" | "tts_only";
  };
  voice: VoiceRecord;
  history?: MeetingHistory;
  requestToken: string;
  suppression?: { channelId: string; expectedVersion?: number };
};
export type SessionReservationWriteResult =
  { kind: "admitted" } | Extract<SessionAdmissionResult, { kind: "blocked" }>;
export const promotionInputSchema = z
  .object({
    coordinatorToken: id,
    coordinatorEpoch: generation,
    expectedServingGeneration: generation,
    candidate: runtimeIdentitySchema,
    candidateRuntimeMode: runtimeModeSchema,
    expectedServingMembers: runtimeMembersSchema,
    retainedMembers: runtimeMembersSchema.optional(),
    proposedGeneration: generation,
    now: epochSecond,
  })
  .strict()
  .refine(
    (input) => input.proposedGeneration > input.expectedServingGeneration,
    "Promotion generation must increase",
  )
  .refine((input) => {
    const retained = input.retainedMembers ?? [];
    return (
      retained.length < 98 &&
      input.expectedServingMembers.every(
        (member) => member.kind === input.candidate.kind,
      ) &&
      !retained.some(
        (member) => member.instanceId === input.candidate.instanceId,
      ) &&
      retained.every((member) =>
        input.expectedServingMembers.some((expected) =>
          sameRuntimeIdentity(member, expected),
        ),
      )
    );
  }, "Retained runtimes must be selected existing members, distinct from the candidate");
export type PromotionInput = z.infer<typeof promotionInputSchema>;
export type AdmissionCheckResult =
  { kind: "admitted" } | { kind: "blocked"; reason: "not_serving" };
export type SessionReservation = {
  timingReceipt?: { reservedAt: number; monotonicMilliseconds: number };
  guildId: string;
  meetingId: string;
  ownerInstanceId: string;
  executionVersion: number;
  voiceOperationAttemptId: string;
  reservedAt: number;
  workHandle: RuntimeWorkHandle & {
    transition(kind: RuntimeWorkKind): void;
    beginOwnedControl(): RuntimeWorkHandle;
  };
} & (
  | { sessionMode: "meeting"; historyKey: HistoryKey }
  | { sessionMode: "tts_only"; historyKey?: never }
);
export type SessionAdmissionResult =
  | { kind: "admitted"; reservation: SessionReservation }
  | {
      kind: "blocked";
      reason:
        | "active_session"
        | "not_serving"
        | "unavailable"
        | "voice_uncertain"
        | "suppressed";
    };
export type RetirementResult = {
  kind: "retired" | "busy" | "uncertain";
  counts: Partial<Record<RuntimeWorkKind, number>>;
  reason?: "work_remaining" | "voice_unsettled" | "dependency_unavailable";
};
export type HistoryKey = Pick<
  MeetingHistory,
  "guildId" | "channelId_timestamp"
>;
export const HISTORY_TRANSITION_FIELDS = [
  "fixtureInput",
  "fixtureGeneration",
  "fixtureTranscript",
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
] as const;
export type TerminalCheckpointPreservation = {
  kind: "terminal_preservation";
  ownership: SessionOwnership & { sessionMode: "meeting" };
  now: number;
};
export type CheckpointPublication = {
  kind: "checkpoint_publication";
  ownership: SessionOwnership & { sessionMode: "meeting" };
  now: number;
};
export type InitialTerminalCheckpointDisposition = {
  kind: "initial_terminal_disposition";
  ownership: TerminalCheckpointPreservation["ownership"];
  now: number;
};
export const RECORDING_DELIVERY_FIELDS = [
  "recovery",
  "summaryMessageId",
  "notesMessageIds",
  "notesChannelId",
  "notesDeliveryTiming",
] as const;
export type RecordingDeliveryProof = {
  kind: "recording_delivery";
  phase: "intent" | "acknowledgment";
  ownership: TerminalCheckpointPreservation["ownership"];
  now: number;
  previous: Pick<MeetingHistory, (typeof RECORDING_DELIVERY_FIELDS)[number]>;
};
export type HistoryTransition = {
  expectedPublication?: import("./meetingPublication").MeetingPublicationSnapshot;
  completionPolicyProof?: {
    kind: "completion_policy";
    ownership: CheckpointPublication["ownership"];
    now: number;
  };
  recordingDelivery?: RecordingDeliveryProof;
  initialTerminalDisposition?: InitialTerminalCheckpointDisposition;
  checkpointPublication?: CheckpointPublication;
  terminalPreservation?: TerminalCheckpointPreservation;
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
function validateFixtureHistoryTransition(input: HistoryTransition): void {
  if (
    input.patch.fixtureInput ||
    input.patch.fixtureGeneration ||
    input.patch.fixtureTranscript
  ) {
    const fixture = fixtureInputEvidenceSchema.parse(input.patch.fixtureInput);
    if (
      input.expectedStatus !== "processing" ||
      input.patch.status !== "complete" ||
      fixture.historyKey.guildId !== input.key.guildId ||
      fixture.historyKey.channelId_timestamp !==
        input.key.channelId_timestamp ||
      fixture.ownership.meetingId !== input.expectedMeetingId ||
      fixture.ownership.ownerInstanceId !== input.expectedOwnerInstanceId ||
      fixture.ownership.executionVersion !== input.expectedExecutionVersion
    )
      throw new Error("Fixture history requires its original completion");
    fixtureGenerationSchema.parse(input.patch.fixtureGeneration);
    if (input.patch.fixtureTranscript)
      fixtureTranscriptSchema.parse(input.patch.fixtureTranscript);
  }
}

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
  validateFixtureHistoryTransition(input);
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
  if (input.recordingDelivery) validateRecordingDelivery(input);
  if (input.initialTerminalDisposition)
    validateInitialTerminalDisposition(input);
  if (input.terminalPreservation) validateTerminalCheckpointPreservation(input);
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
    if (
      [
        input.recordingDelivery,
        input.checkpointPublication,
        input.terminalPreservation,
        input.initialTerminalDisposition,
      ].some(Boolean)
    )
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
function validateRecordingDelivery(input: HistoryTransition) {
  const proof = input.recordingDelivery!;
  z.enum(["intent", "acknowledgment"]).parse(proof.phase);
  const owner = proof.ownership;
  id.parse(owner.voiceOperationAttemptId);
  epochSecond.parse(proof.now);
  z.number().int().nonnegative().parse(input.expectedCheckpointRevision);
  if (
    input.initialTerminalDisposition ||
    input.terminalPreservation ||
    input.checkpointPublication ||
    !input.signal ||
    proof.kind !== "recording_delivery" ||
    owner.sessionMode !== "meeting" ||
    owner.guildId !== input.key.guildId ||
    owner.meetingId !== input.expectedMeetingId ||
    owner.ownerInstanceId !== input.expectedOwnerInstanceId ||
    owner.executionVersion !== input.expectedExecutionVersion
  )
    throw new Error("Recording delivery requires exact original authority");
  validateDeliveryPatch(input, proof);
}
function validateDeliveryPatch(
  input: HistoryTransition,
  proof: RecordingDeliveryProof,
) {
  const allowed =
    proof.phase === "intent"
      ? ["recovery", "updatedAt"]
      : [...RECORDING_DELIVERY_FIELDS, "updatedAt"];
  if (
    Object.keys(input.patch).some((field) => !allowed.includes(field)) ||
    !["processing", "complete"].includes(input.expectedStatus)
  )
    throw new Error("Recording delivery is metadata only");
  const recovery = validateDeliveryRecovery(input, proof);
  if (proof.phase === "intent" && proof.previous.recovery?.stage === "delivery")
    throw new Error("Existing delivery cannot be replayed");
  if (proof.phase === "acknowledgment")
    validatePriorDeliveryMarker(proof, recovery.disposition);
  validateAcknowledgedDeliveryIds(input, proof);
  validateAcknowledgedNotesTiming(input, proof);
}
function validateDeliveryRecovery(
  input: HistoryTransition,
  proof: RecordingDeliveryProof,
) {
  const recovery = input.patch.recovery;
  if (
    !recovery ||
    recovery.stage !== "delivery" ||
    recovery.executionVersion !== input.expectedExecutionVersion
  )
    throw new Error("Recording delivery stage mismatch");
  if (recovery.disposition === "done") {
    if (
      proof.phase !== "acknowledgment" ||
      input.expectedStatus !== "complete" ||
      recovery.outcome !== "completed"
    )
      throw new Error("Delivery completion requires terminal history");
  } else if (
    recovery.disposition !== "needs_reconciliation" ||
    recovery.reason !== "delivery_uncertain" ||
    input.expectedStatus !== "processing"
  )
    throw new Error("Delivery uncertainty must remain retained");
  return recovery;
}
function validatePriorDeliveryMarker(
  proof: RecordingDeliveryProof,
  disposition: string,
) {
  const previous = proof.previous.recovery;
  if (
    !previous ||
    previous.stage !== "delivery" ||
    previous.executionVersion !== proof.ownership.executionVersion ||
    !["needs_reconciliation", "done"].includes(previous.disposition)
  )
    throw new Error(
      "Delivery acknowledgment requires its original durable intent",
    );
  if (previous.disposition === "done" && disposition !== "done")
    throw new Error("Completed delivery cannot become replayable");
}
function validateAcknowledgedDeliveryIds(
  input: HistoryTransition,
  proof: RecordingDeliveryProof,
) {
  if (input.patch.summaryMessageId !== undefined)
    id.parse(input.patch.summaryMessageId);
  if (input.patch.notesChannelId !== undefined)
    id.parse(input.patch.notesChannelId);
  if (input.patch.notesMessageIds)
    z.array(id).min(1).parse(input.patch.notesMessageIds);
  for (const field of ["summaryMessageId", "notesChannelId"] as const) {
    if (
      proof.previous[field] &&
      input.patch[field] !== undefined &&
      proof.previous[field] !== input.patch[field]
    )
      throw new Error("Acknowledged delivery identity cannot be replaced");
  }
  if (
    input.patch.notesMessageIds &&
    !proof.previous.notesMessageIds?.every((id) =>
      input.patch.notesMessageIds!.includes(id),
    ) &&
    proof.previous.notesMessageIds?.length
  )
    throw new Error("Acknowledged delivery IDs cannot be discarded");
}
function validateAcknowledgedNotesTiming(
  input: HistoryTransition,
  proof: RecordingDeliveryProof,
) {
  const previous = notesDeliveryTimingSchema.safeParse(
    proof.previous.notesDeliveryTiming,
  );
  const next = input.patch.notesDeliveryTiming;
  if (!previous.success || !next) return;
  if (
    next.firstAcknowledgedAt !== previous.data.firstAcknowledgedAt ||
    next.path !== previous.data.path ||
    (previous.data.kind === "complete" &&
      (next.kind !== "complete" ||
        next.completeAcknowledgedAt !== previous.data.completeAcknowledgedAt))
  )
    throw new Error("Acknowledged notes timing cannot be replaced");
}

function validateCheckpointPublication(input: HistoryTransition) {
  const proof = input.checkpointPublication!;
  const owner = proof.ownership;
  id.parse(owner.voiceOperationAttemptId);
  epochSecond.parse(proof.now);
  z.number().int().nonnegative().parse(input.expectedCheckpointRevision);
  if (
    proof.kind !== "checkpoint_publication" ||
    input.terminalPreservation ||
    input.initialTerminalDisposition ||
    input.recordingDelivery ||
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

function validateInitialTerminalDisposition(input: HistoryTransition) {
  const proof = input.initialTerminalDisposition!;
  if (
    proof.kind !== "initial_terminal_disposition" ||
    input.terminalPreservation ||
    input.checkpointPublication ||
    input.recordingDelivery ||
    !["starting", "in_progress", "processing"].includes(input.expectedStatus) ||
    !["failed", "interrupted"].includes(input.patch.status ?? "") ||
    !input.patch.capture ||
    !input.patch.recovery
  )
    throw new Error(
      "Initial terminal disposition requires original active history and recovery metadata",
    );
  const { status, ...patch } = input.patch;
  validateTerminalCheckpointPreservation({
    ...input,
    expectedStatus: status!,
    patch,
    terminalPreservation: { ...proof, kind: "terminal_preservation" },
  });
}

function validateTerminalCheckpointPreservation(input: HistoryTransition) {
  const proof = input.terminalPreservation;
  if (!proof || proof.kind !== "terminal_preservation")
    throw new Error("Terminal preservation authority required");
  z.number().int().nonnegative().parse(input.expectedCheckpointRevision);
  const owner = proof.ownership;
  if (
    !["failed", "interrupted"].includes(input.expectedStatus) ||
    !input.signal ||
    Object.keys(input.patch).some(
      (field) =>
        !["checkpoint", "capture", "captureCoverage", "recovery"].includes(
          field,
        ),
    )
  )
    throw new Error("Terminal preservation is metadata only");
  id.parse(owner.voiceOperationAttemptId);
  epochSecond.parse(proof.now);
  if (
    owner.guildId !== input.key.guildId ||
    owner.meetingId !== input.expectedMeetingId ||
    owner.ownerInstanceId !== input.expectedOwnerInstanceId ||
    owner.executionVersion !== input.expectedExecutionVersion ||
    owner.sessionMode !== "meeting"
  )
    throw new Error("Terminal preservation owner mismatch");
  if (
    input.patch.recovery &&
    (!["pending", "needs_reconciliation"].includes(
      input.patch.recovery.disposition,
    ) ||
      input.patch.recovery.executionVersion !== input.expectedExecutionVersion)
  )
    throw new Error("Terminal preservation cannot complete recovery");
}

function validateCheckpointTransition(input: HistoryTransition) {
  if (input.patch.checkpoint) {
    if (
      !input.terminalPreservation &&
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

export type CompatibleReplacementInput = {
  control: ControlRecord;
  candidate: RuntimeRecord;
  members: RuntimeRecord[];
  now: number;
};
