import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { fixtureGrantSchema } from "../types/productionIntroduction";
import {
  fixtureInputEvidenceSchema,
  fixtureGenerationSchema,
  fixtureTranscriptSchema,
} from "../types/fixtureEvidence";
import {
  recordingCheckpointSchema,
  recordingCaptureStateSchema,
  recoveryDispositionSchema,
} from "../types/recordingCheckpoint";
import { notesDeliveryTimingSchema } from "../types/meetingNotesTiming";
import { validateFixtureCapture } from "./fixtureEvidenceValidation";

const id = z.string().min(1).max(1024);
const delivery = z
  .object({
    outcome: z.literal("complete"),
    intended: z.number().int().positive(),
    sent: z.number().int().positive(),
    errors: z.array(z.unknown()).length(0),
  })
  .strict();
export const fixtureHistoryMetadataSchema = z
  .object({
    guildId: id,
    channelId_timestamp: id,
    meetingId: id,
    channelId: id,
    textChannelId: id,
    ownerInstanceId: id,
    executionVersion: z.literal(1),
    status: z.literal("complete"),
    transcribeMeeting: z.literal(true),
    generateNotes: z.literal(true),
    fixtureInput: fixtureInputEvidenceSchema,
    fixtureGeneration: fixtureGenerationSchema,
    fixtureTranscript: fixtureTranscriptSchema,
    checkpoint: recordingCheckpointSchema,
    capture: recordingCaptureStateSchema,
    recovery: recoveryDispositionSchema,
    notesVersion: z.literal(1),
    notesChannelId: id,
    notesMessageIds: z.array(id).min(1).max(100),
    summaryMessageId: id,
    transcriptS3Key: id,
    notesDeliveryTiming: notesDeliveryTimingSchema,
    processing: z
      .object({
        transcription: z.literal("ready"),
        notes: z.literal("generated"),
        summary: z.literal("generated"),
      })
      .strict(),
    delivery: z
      .object({
        notes: delivery,
        summary: delivery
          .extend({ outcome: z.enum(["edited_existing", "sent_fallback"]) })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type FixtureHistoryMetadata = z.infer<
  typeof fixtureHistoryMetadataSchema
>;

function refuse(): never {
  throw new Error("fixture_metadata_refused");
}

type ConsumedGrant = Extract<
  z.infer<typeof fixtureGrantSchema>,
  { state: "consumed" }
>;
function validateHistoryIdentity(
  grant: ConsumedGrant,
  history: FixtureHistoryMetadata,
) {
  if (
    history.guildId !== grant.guildId ||
    history.channelId_timestamp !== grant.historyKey.channelId_timestamp ||
    history.meetingId !== grant.meetingId ||
    history.channelId !== grant.voiceChannelId ||
    history.textChannelId !== grant.textChannelId ||
    history.notesChannelId !== grant.textChannelId ||
    history.ownerInstanceId !== grant.ownership.ownerInstanceId
  )
    refuse();
}
function validateInputBinding(
  grant: ConsumedGrant,
  history: FixtureHistoryMetadata,
) {
  const observed = history.fixtureInput;
  const reference = {
    holdId: grant.holdId,
    introductionId: grant.introductionId,
    revision: grant.revision,
    grantId: grant.grantId,
  };
  if (
    !isDeepStrictEqual(observed.reference, reference) ||
    !isDeepStrictEqual(observed.ownership, grant.ownership) ||
    !isDeepStrictEqual(observed.historyKey, grant.historyKey) ||
    observed.commandId !== grant.commandId ||
    observed.actorUserId !== grant.actorUserId ||
    observed.profile !== grant.inputProfile ||
    observed.scriptSha256 !== grant.scriptSha256 ||
    observed.checklistSha256 !== grant.checklistSha256
  )
    refuse();
}
function validateClosedInput(
  grant: ConsumedGrant,
  history: FixtureHistoryMetadata,
) {
  const observed = history.fixtureInput,
    capture = history.checkpoint.capture;
  if (
    observed.state !== "closed" ||
    observed.acceptedPcmChunks === 0 ||
    observed.acceptedPcmBytes === 0 ||
    !capture.requested.transcribeMeeting ||
    !capture.requested.generateNotes ||
    capture.channelId !== grant.voiceChannelId
  )
    refuse();
  validateFixtureCapture(capture, observed);
  inspectFixtureGeneration(history.fixtureGeneration);
}
function validateDelivery(history: FixtureHistoryMetadata) {
  const recovery = history.recovery;
  if (
    recovery.disposition !== "done" ||
    recovery.attempt !== 0 ||
    recovery.executionVersion !== 1 ||
    recovery.stage !== "delivery" ||
    recovery.outcome !== "completed" ||
    history.delivery.notes.sent !== history.delivery.notes.intended ||
    history.delivery.notes.sent !== history.notesMessageIds.length ||
    history.delivery.summary.sent !== history.delivery.summary.intended ||
    history.delivery.summary.sent !== 1 ||
    new Set(history.notesMessageIds).size !== history.notesMessageIds.length
  )
    refuse();
  validateTranscript(history);
}
function validateTranscript(history: FixtureHistoryMetadata) {
  const transcript = history.fixtureTranscript;
  if (
    transcript.key !== history.transcriptS3Key ||
    transcript.byteLength === 0 ||
    transcript.acknowledgment.state !== "acknowledged" ||
    transcript.acknowledgment.versionId === null ||
    transcript.acknowledgment.versionId === "null"
  )
    refuse();
}
function validateChronology(
  times: (string | null)[],
  validFrom: number,
  now: number,
) {
  const millis = times.map((value) =>
    value === null ? NaN : Date.parse(value),
  );
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(validFrom) ||
    millis.some(
      (value, index) =>
        !Number.isFinite(value) ||
        value < validFrom * 1000 ||
        value > now * 1000 ||
        (index > 0 && value < millis[index - 1]),
    )
  )
    refuse();
}
/** Pure metadata check. A successful result grants no content or execution authority. */
export function inspectFixtureMetadata(input: {
  grant: unknown;
  history: unknown;
  validFrom: number;
  now: number;
}) {
  const grant = fixtureGrantSchema.parse(input.grant),
    history = fixtureHistoryMetadataSchema.parse(input.history);
  if (grant.state !== "consumed") refuse();
  validateHistoryIdentity(grant, history);
  validateInputBinding(grant, history);
  validateClosedInput(grant, history);
  validateDelivery(history);
  const state = history.capture,
    timing = history.notesDeliveryTiming,
    observed = history.fixtureInput;
  if (
    state.kind !== "complete" ||
    timing.kind !== "complete" ||
    timing.path !== "live" ||
    state.startedAt !== observed.captureStartedAt ||
    state.endedAt !== observed.captureEndedAt ||
    Date.parse(state.endedAt) <= Date.parse(state.startedAt)
  )
    refuse();
  validateChronology(
    [
      history.checkpoint.capture.reservedAt,
      observed.observationStartedAt,
      state.startedAt,
      state.endedAt,
      observed.observationEndedAt,
      timing.firstAcknowledgedAt,
      timing.completeAcknowledgedAt,
    ],
    input.validFrom,
    input.now,
  );
  return {
    history,
    grant,
    firstNotesWaitMs:
      Date.parse(timing.firstAcknowledgedAt) - Date.parse(state.endedAt),
    completeNotesWaitMs:
      Date.parse(timing.completeAcknowledgedAt) - Date.parse(state.endedAt),
  };
}

export function inspectFixtureGeneration(value: unknown) {
  const generation = fixtureGenerationSchema.parse(value);
  if (
    generation.overflow ||
    generation.missing ||
    generation.submitted === 0 ||
    generation.submitted !== generation.acknowledged ||
    generation.tuples.reduce((sum, tuple) => sum + tuple.count, 0) !==
      generation.acknowledged ||
    generation.tuples.some(
      (tuple) =>
        tuple.count === 0 ||
        tuple.prompt.kind === "missing" ||
        (!tuple.stage.startsWith("transcription-audio-") &&
          tuple.returnedModel === null),
    ) ||
    !generation.tuples.some((tuple) =>
      tuple.stage.startsWith("transcription-audio-"),
    ) ||
    !["notes", "summary"].every((stage) =>
      generation.tuples.some((tuple) => tuple.stage === stage),
    )
  )
    refuse();
  return generation;
}

export function inspectFixtureFallbacks(
  value: unknown,
  transcriptionPromptName: string,
) {
  const generation = inspectFixtureGeneration(value);
  const paths = new Set<string>();
  for (const tuple of generation.tuples) {
    const prompt = tuple.prompt;
    if (prompt.kind !== "resolved") continue;
    if (!prompt.fallback && prompt.version > 0) continue;
    if (
      !prompt.fallback ||
      prompt.version !== 0 ||
      !tuple.stage.startsWith("transcription-audio-") ||
      prompt.name !== transcriptionPromptName
    )
      refuse();
    paths.add("src/services/transcriptionPromptService.ts");
  }
  return [...paths];
}
