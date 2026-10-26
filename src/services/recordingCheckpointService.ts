import { fixtureInputSnapshot } from "./fixtureInputService";
import { validateFixtureCapture } from "./fixtureEvidenceValidation";
import { createHash } from "node:crypto";
import { summarizeCaptureCoverage } from "../utils/meetingCaptureNotice";
import { isDeepStrictEqual } from "node:util";
import { getDeploymentControlRepository } from "../db";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import type {
  TerminalCheckpointPreservation,
  HistoryTransition,
  CheckpointPublication,
} from "../types/deploymentControl";
import type { MeetingHistory } from "../types/db";
import type { MeetingData } from "../types/meeting-data";
import type { MeetingStatus } from "../types/meetingLifecycle";
import {
  checkpointArtifactSchema,
  recordingCaptureProvenanceSchema,
  recordingCaptureStateSchema,
  recordingCheckpointSchema,
  recordingManifestSchema,
  type CaptureCoverage,
  type CheckpointAppendResult,
  type CheckpointArtifact,
  type CheckpointArtifactInput,
  type CheckpointObject,
  type CheckpointSegmentInput,
  type RecordingCaptureProvenance,
  type RecordingCaptureState,
  type RecordingCheckpoint,
  type RecoveryDisposition,
  type RecordingCoverage,
  type RecordingManifest,
} from "../types/recordingCheckpoint";
import { fetchObjectBytesFromS3, uploadObjectToS3 } from "./storageService";
import { getRecordingArtifactFolder } from "./uploadService";

export type RecordingCheckpointMeeting = Pick<
  MeetingData,
  | "reservation"
  | "meetingId"
  | "guildId"
  | "ownershipSignal"
  | "captureStartedAt"
  | "transcribeMeeting"
  | "generateNotes"
  | "recordingCaptureState"
  | "recordingCheckpoint"
> & { voiceChannel: Pick<MeetingData["voiceChannel"], "id"> };
type Repository = Pick<
  DeploymentControlRepository,
  "transitionMeetingHistory" | "getMeetingHistory"
>;
type Objects = {
  upload: typeof uploadObjectToS3;
  read: typeof fetchObjectBytesFromS3;
};
export type CheckpointFlushInput = {
  fixtureInput?: import("../types/fixtureEvidence").FixtureInputEvidence;
  ownership?: CheckpointPublication["ownership"];
  capture: RecordingCaptureProvenance;
  captureState?: RecordingCaptureState;
  expectedStatus: MeetingStatus;
  previous: RecordingCheckpoint | undefined;
  artifacts: readonly CheckpointArtifactInput[];
  signal?: AbortSignal;
};
export type TerminalRecordingCheckpointInput = Omit<
  CheckpointFlushInput,
  "expectedStatus" | "signal"
> & {
  expectedStatus: "failed" | "interrupted";
  captureState: RecordingCaptureState;
  recovery: RecoveryDisposition;
  preservation: {
    ownership: TerminalCheckpointPreservation["ownership"];
    deadlineEpochMs: number;
    signal: AbortSignal;
    assertOwnership(signal: AbortSignal): Promise<void>;
  };
};
export type InitialTerminalRecordingCheckpointInput = Omit<
  TerminalRecordingCheckpointInput,
  "expectedStatus"
> & {
  expectedStatus: "starting" | "in_progress" | "processing";
  status: "failed" | "interrupted";
};
type Preservation = Pick<
  TerminalRecordingCheckpointInput,
  "preservation" | "recovery"
> & { status?: "failed" | "interrupted" };
async function assertPreservation(
  proof: Preservation | undefined,
  signal: AbortSignal | undefined,
) {
  if (!proof) return;
  if (!signal || Date.now() >= proof.preservation.deadlineEpochMs)
    throw new Error("Preservation deadline elapsed");
  signal.throwIfAborted();
  await proof.preservation.assertOwnership(signal);
  signal.throwIfAborted();
  if (Date.now() >= proof.preservation.deadlineEpochMs)
    throw new Error("Preservation deadline elapsed");
}
export type CheckpointFlushResult = CheckpointAppendResult;
const checksum = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (
  item: Pick<CheckpointArtifact, "kind" | "sourceId" | "sequence">,
) => JSON.stringify([item.kind, item.sourceId, item.sequence]);
const unknownCoverage = (
  reason: Extract<CaptureCoverage, { kind: "unknown" }>["reason"],
): CaptureCoverage => ({
  kind: "unknown",
  reason,
  detectedAt: new Date().toISOString(),
});
const isCaptureStatus = (status: MeetingStatus) =>
  ["starting", "in_progress", "processing"].includes(status);
function attemptFolder(
  capture: RecordingCaptureProvenance,
  artifactFolder: string,
): string {
  return `${artifactFolder}checkpoints/v1/${capture.executionVersion}-${encodeURIComponent(capture.ownerInstanceId)}/`;
}
function objectRef(key: string, bytes: Uint8Array): CheckpointObject {
  return { key, checksumSha256: checksum(bytes), byteLength: bytes.byteLength };
}
function artifactRef(
  capture: RecordingCaptureProvenance,
  input: CheckpointArtifactInput,
  folder: string,
): CheckpointArtifact {
  if (checksum(input.bytes) !== input.checksumSha256)
    throw new Error("Checkpoint checksum mismatch");
  const key = `${attemptFolder(capture, folder)}${input.kind}/${encodeURIComponent(input.sourceId)}/${input.sequence}-${input.checksumSha256}`;
  const artifact = checkpointArtifactSchema.parse({
    kind: input.kind,
    sourceId: input.sourceId,
    sequence: input.sequence,
    coverage: input.coverage,
    contentType: input.contentType,
    ...(input.kind === "audio"
      ? {
          format: input.format,
          ...(input.timing ? { timing: input.timing } : {}),
        }
      : {}),
    object: objectRef(key, input.bytes),
  });
  if (artifact.kind === "audio") validatePcm(artifact);
  return artifact;
}
function validatePcm(artifact: Extract<CheckpointArtifact, { kind: "audio" }>) {
  const frameSize = artifact.format.channels * 2;
  if (
    artifact.object.byteLength === 0 ||
    artifact.object.byteLength % frameSize !== 0
  )
    throw new Error("Checkpoint PCM frame size mismatch");
  if (artifact.coverage.kind === "known") {
    const duration = artifact.coverage.intervals.reduce(
      (sum, interval) => sum + interval.durationMs,
      0,
    );
    if (
      Math.abs(
        duration -
          (artifact.object.byteLength /
            frameSize /
            artifact.format.sampleRate) *
            1000,
      ) > 0.000001
    )
      throw new Error("Checkpoint PCM duration mismatch");
  }
}
function audioCoverage(artifacts: CheckpointArtifact[]): RecordingCoverage {
  const audio = artifacts.filter((item) => item.kind === "audio");
  // Reconciled sample positions preserve duration, not exact physical wall time.
  if (
    audio.some(
      (item) =>
        item.coverage.kind === "unknown" ||
        (item.timing?.maxCursorAdjustmentMs ?? 0) > 0,
    )
  )
    return { kind: "unknown" };
  return {
    kind: "known",
    intervals: audio.flatMap((item) =>
      item.coverage.kind === "known" ? item.coverage.intervals : [],
    ),
  };
}
function savedDuration(
  intervals: Extract<RecordingCoverage, { kind: "known" }>["intervals"],
) {
  let duration = 0;
  let end = 0;
  for (const interval of [...intervals].sort(
    (a, b) => a.startOffsetMs - b.startOffsetMs,
  )) {
    const nextEnd = interval.startOffsetMs + interval.durationMs;
    duration += Math.max(0, nextEnd - Math.max(end, interval.startOffsetMs));
    end = Math.max(end, nextEnd);
  }
  return { duration, end };
}
function confirmedCoverage(
  capture: RecordingCaptureProvenance,
  artifacts: CheckpointArtifact[],
  state: RecordingCaptureState,
): CaptureCoverage {
  const stoppedAt =
    state.kind === "complete" || state.kind === "interrupted"
      ? state.endedAt
      : undefined;
  const stop = stoppedAt ? { stoppedAt } : {};
  if (!capture.captureStartedAt)
    return { ...unknownCoverage("capture_start_unknown"), ...stop };
  const source = audioCoverage(artifacts);
  if (source.kind === "unknown")
    return { ...unknownCoverage("source_intervals_unknown"), ...stop };
  if (!source.intervals.length)
    return { ...unknownCoverage("no_verified_audio"), ...stop };
  const saved = savedDuration(source.intervals);
  return {
    kind: "verified",
    intervals: source.intervals,
    savedDurationMs: saved.duration,
    lastConfirmedCaptureAt: new Date(
      Date.parse(capture.captureStartedAt) + saved.end,
    ).toISOString(),
    ...stop,
  };
}
function mergeArtifacts(
  previous: RecordingManifest | undefined,
  additions: CheckpointArtifact[],
) {
  const artifacts = [...(previous?.artifacts ?? [])];
  for (const reference of additions) {
    const existing = artifacts.find(
      (item) => identity(item) === identity(reference),
    );
    if (existing && !isDeepStrictEqual(existing, reference))
      throw new Error("Conflicting checkpoint segment identity");
    if (!existing) artifacts.push(reference);
  }
  return artifacts;
}
function validateCaptureHistory(
  row: MeetingHistory | undefined,
  capture: RecordingCaptureProvenance,
) {
  if (
    !row ||
    row.channelId !== capture.channelId ||
    row.meetingId !== capture.meetingId ||
    Date.parse(row.timestamp) !== Date.parse(capture.reservedAt) ||
    row.transcribeMeeting !== capture.requested.transcribeMeeting ||
    row.generateNotes !== capture.requested.generateNotes
  )
    throw new Error("Checkpoint history or requested settings mismatch");
}
function sameCheckpoint(
  left: RecordingCheckpoint | undefined,
  right: RecordingCheckpoint | undefined,
) {
  if (!left || !right) return left === right;
  return isDeepStrictEqual(
    recordingCheckpointSchema.parse(left),
    recordingCheckpointSchema.parse(right),
  );
}
function assertCompleteCapturePreserved(
  state: RecordingCaptureState,
  known: RecordingCaptureState | undefined,
) {
  if (
    known?.kind === "complete" &&
    !isDeepStrictEqual(recordingCaptureStateSchema.parse(known), state)
  )
    throw new Error("Known complete capture cannot be relabeled");
}
function captureState(
  input: CheckpointFlushInput,
  previous?: RecordingManifest,
): RecordingCaptureState {
  const state = recordingCaptureStateSchema.parse(
    input.captureState ?? previous?.captureState ?? { kind: "unknown" },
  );
  if (
    "startedAt" in state &&
    state.startedAt !== input.capture.captureStartedAt
  )
    throw new Error(
      "Capture state start differs from actual capture provenance",
    );
  if (
    "endedAt" in state &&
    state.endedAt &&
    state.startedAt &&
    Date.parse(state.endedAt) < Date.parse(state.startedAt)
  )
    throw new Error("Capture stop precedes capture start");
  return state;
}
function matchesAcknowledgedTransition(
  row: MeetingHistory | undefined,
  transition: HistoryTransition,
): boolean {
  return !(
    row?.meetingId !== transition.expectedMeetingId ||
    row.ownerInstanceId !== transition.expectedOwnerInstanceId ||
    row.executionVersion !== transition.expectedExecutionVersion ||
    row.status !== (transition.patch.status ?? transition.expectedStatus) ||
    (row.checkpoint?.revision ?? 0) !==
      (transition.patch.checkpoint?.revision ??
        transition.expectedCheckpointRevision) ||
    !Object.entries(transition.patch).every(
      ([field, value]) =>
        value === undefined ||
        isDeepStrictEqual(
          JSON.parse(
            JSON.stringify(row[field as keyof MeetingHistory] ?? null),
          ),
          JSON.parse(JSON.stringify(value)),
        ),
    )
  );
}
function fixtureEvidenceFields(
  fixtureInput: RecordingManifest["fixtureInput"],
) {
  return fixtureInput ? { fixtureInput } : {};
}
function selectedFixtureEvidence(
  input: CheckpointFlushInput,
  previous: RecordingManifest | undefined,
) {
  const fixtureInput = input.fixtureInput ?? previous?.fixtureInput;
  validateFixtureCapture(input.capture, fixtureInput, previous?.fixtureInput);
  return fixtureInput;
}
function checkpointMetadataChanged(
  state: RecordingCaptureState,
  fixtureInput: RecordingManifest["fixtureInput"],
  previous: RecordingManifest | undefined,
) {
  return (
    !isDeepStrictEqual(state, previous?.captureState) ||
    !isDeepStrictEqual(fixtureInput, previous?.fixtureInput)
  );
}
export function createRecordingCheckpointService(
  dependencies: { repository: Repository; objects: Objects } = {
    repository: getDeploymentControlRepository(),
    objects: { upload: uploadObjectToS3, read: fetchObjectBytesFromS3 },
  },
  producerSession = false,
) {
  const { repository, objects } = dependencies;
  let acknowledged:
    | { checkpoint: RecordingCheckpoint; manifest: RecordingManifest }
    | undefined;
  let pinnedCapture: RecordingCaptureProvenance | undefined;
  let pinnedOwnership: CheckpointPublication["ownership"] | undefined;
  let publishing = false;
  async function verifiedBytes(
    reference: CheckpointObject,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const bytes = await objects.read(reference.key, signal);
    signal?.throwIfAborted();
    if (
      !bytes ||
      bytes.byteLength !== reference.byteLength ||
      checksum(bytes) !== reference.checksumSha256
    )
      return undefined;
    return bytes;
  }
  async function preserve(
    reference: CheckpointObject,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    await objects.upload(reference.key, bytes, contentType, {
      immutable: true,
      signal,
    });
    signal?.throwIfAborted();
    if (!(await verifiedBytes(reference, signal)))
      throw new Error("Checkpoint object was not preserved");
  }
  async function loadManifest(
    checkpoint: RecordingCheckpoint,
    signal?: AbortSignal,
  ): Promise<RecordingManifest> {
    const pointer = recordingCheckpointSchema.parse(checkpoint);
    const prefix = attemptFolder(pointer.capture, pointer.artifactFolder);
    if (
      !pointer.artifactFolder.endsWith(
        getRecordingArtifactFolder(pointer.capture, ""),
      ) ||
      pointer.manifest.key !==
        `${prefix}manifests/${pointer.revision}-${pointer.manifest.checksumSha256}.json`
    )
      throw new Error("Checkpoint manifest binding mismatch");
    const bytes = await verifiedBytes(pointer.manifest, signal);
    if (!bytes) throw new Error("Checkpoint manifest was not preserved");
    const manifest = recordingManifestSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    if (
      !isDeepStrictEqual(manifest.capture, pointer.capture) ||
      manifest.revision !== pointer.revision ||
      manifest.artifactFolder !== pointer.artifactFolder
    )
      throw new Error("Checkpoint capture binding mismatch");
    validateFixtureCapture(manifest.capture, manifest.fixtureInput);
    const identities = new Set<string>();
    for (const item of manifest.artifacts) {
      const expected = `${prefix}${item.kind}/${encodeURIComponent(item.sourceId)}/${item.sequence}-${item.object.checksumSha256}`;
      if (item.object.key !== expected || identities.has(identity(item)))
        throw new Error("Checkpoint artifact binding mismatch");
      if (item.kind === "audio") validatePcm(item);
      identities.add(identity(item));
    }
    return manifest;
  }
  async function verifyArtifacts(
    artifacts: CheckpointArtifact[],
    signal?: AbortSignal,
  ) {
    const verified: CheckpointArtifact[] = [];
    const missing: CheckpointArtifact[] = [];
    for (const item of artifacts) {
      if (await verifiedBytes(item.object, signal)) verified.push(item);
      else missing.push(item);
    }
    return { verified, missing };
  }
  async function read(checkpoint: RecordingCheckpoint, signal?: AbortSignal) {
    const manifest = await loadManifest(checkpoint, signal);
    const result = await verifyArtifacts(manifest.artifacts, signal);
    return {
      manifest,
      ...result,
      audioCoverage: audioCoverage(result.verified),
      coverage: confirmedCoverage(
        manifest.capture,
        result.verified,
        manifest.captureState,
      ),
    };
  }
  async function commitTransition(transition: HistoryTransition) {
    try {
      return await repository.transitionMeetingHistory(transition);
    } catch (error) {
      if (
        !transition.initialTerminalDisposition &&
        !transition.terminalPreservation
      )
        throw error;
      transition.signal?.throwIfAborted();
      const row = await repository.getMeetingHistory(
        transition.key,
        transition.signal,
      );
      transition.signal?.throwIfAborted();
      if (!matchesAcknowledgedTransition(row, transition)) throw error;
      return "applied" as const;
    }
  }
  async function publish(
    input: CheckpointFlushInput,
    artifacts: CheckpointArtifact[],
    previous: RecordingManifest | undefined,
    proof?: Preservation,
  ): Promise<CheckpointAppendResult> {
    const capture = input.capture;
    const state = captureState(input, previous);
    const fixtureInput = selectedFixtureEvidence(input, previous);
    assertCompleteCapturePreserved(state, previous?.captureState);
    const key = {
      guildId: capture.guildId,
      channelId_timestamp: capture.channelId_timestamp,
    };
    const row = await repository.getMeetingHistory(key, input.signal);
    input.signal?.throwIfAborted();
    validateCaptureHistory(row, capture);
    assertCompleteCapturePreserved(state, row?.capture);
    const retained =
      producerSession &&
      acknowledged &&
      sameCheckpoint(acknowledged.checkpoint, input.previous)
        ? acknowledged.manifest.artifacts
        : [];
    const retainedIds = new Set(retained.map(identity));
    const additions = artifacts.filter(
      (item) => !retainedIds.has(identity(item)),
    );
    const checked = await verifyArtifacts(additions, input.signal);
    const verified = {
      verified: [...retained, ...checked.verified],
      missing: checked.missing,
    };
    const coverage = confirmedCoverage(capture, verified.verified, state);
    if (!sameCheckpoint(row?.checkpoint, input.previous))
      return { kind: "stale_owner", coverage };
    if (verified.missing.length)
      return { kind: "preservation_failed", coverage };
    let checkpoint = input.previous;
    if (
      !checkpoint ||
      artifacts.length !== previous?.artifacts.length ||
      checkpointMetadataChanged(state, fixtureInput, previous)
    ) {
      const folder =
        previous?.artifactFolder ?? getRecordingArtifactFolder(capture);
      const manifest: RecordingManifest = {
        ...fixtureEvidenceFields(fixtureInput),
        artifactFolder: folder,
        schemaVersion: 1,
        revision: (checkpoint?.revision ?? 0) + 1,
        capture,
        captureState: state,
        coverage,
        artifacts,
      };
      const bytes = Buffer.from(JSON.stringify(manifest));
      const reference = objectRef(
        `${attemptFolder(capture, folder)}manifests/${manifest.revision}-${checksum(bytes)}.json`,
        bytes,
      );
      await preserve(reference, bytes, "application/json", input.signal);
      checkpoint = {
        artifactFolder: folder,
        schemaVersion: 1,
        revision: manifest.revision,
        capture,
        manifest: reference,
      };
    }
    input.signal?.throwIfAborted();
    const patch = proof
      ? {
          ...(checkpoint === input.previous ? {} : { checkpoint }),
          capture: state,
          captureCoverage: summarizeCaptureCoverage(coverage),
          recovery: proof.recovery,
          ...(proof.status ? { status: proof.status } : {}),
        }
      : checkpoint === input.previous
        ? { updatedAt: new Date().toISOString() }
        : { checkpoint };
    await assertPreservation(proof, input.signal);
    const transition: HistoryTransition = {
      key,
      expectedMeetingId: capture.meetingId,
      expectedOwnerInstanceId: capture.ownerInstanceId,
      expectedExecutionVersion: capture.executionVersion,
      expectedStatus: input.expectedStatus,
      expectedCheckpointRevision: input.previous?.revision ?? 0,
      patch,
      signal: input.signal,
      ...(input.ownership && !proof
        ? {
            checkpointPublication: {
              kind: "checkpoint_publication" as const,
              ownership: input.ownership,
              now: Math.floor(Date.now() / 1000),
            },
          }
        : {}),
      ...(proof && !proof.status
        ? {
            terminalPreservation: {
              kind: "terminal_preservation" as const,
              ownership: proof.preservation.ownership,
              now: Math.floor(Date.now() / 1000),
            },
          }
        : {}),
      ...(proof?.status
        ? {
            initialTerminalDisposition: {
              kind: "initial_terminal_disposition",
              ownership: proof.preservation.ownership,
              now: Math.floor(Date.now() / 1000),
            },
          }
        : {}),
    };
    const result = await commitTransition(transition);
    input.signal?.throwIfAborted();
    if (proof && Date.now() >= proof.preservation.deadlineEpochMs)
      throw new Error("Preservation deadline elapsed");
    if (result === "applied" && producerSession) {
      acknowledged = {
        checkpoint,
        manifest: {
          ...fixtureEvidenceFields(fixtureInput),
          artifactFolder: checkpoint.artifactFolder,
          schemaVersion: 1,
          revision: checkpoint.revision,
          capture,
          captureState: state,
          coverage,
          artifacts,
        },
      };
    }
    return result === "applied"
      ? { kind: "committed", checkpoint, coverage }
      : { kind: "stale_owner", coverage };
  }
  async function readForProducer(
    checkpoint: RecordingCheckpoint,
    signal?: AbortSignal,
  ) {
    if (
      !producerSession ||
      !acknowledged ||
      !sameCheckpoint(acknowledged.checkpoint, checkpoint)
    )
      return read(checkpoint, signal);
    const manifest = await loadManifest(checkpoint, signal);
    if (!isDeepStrictEqual(manifest, acknowledged.manifest))
      throw new Error("Producer manifest changed");
    return { manifest, coverage: manifest.coverage, missing: [] };
  }
  async function flushInternal(
    input: CheckpointFlushInput,
    proof?: Preservation,
  ): Promise<CheckpointAppendResult> {
    if (!proof && !isCaptureStatus(input.expectedStatus))
      return {
        kind: "stale_owner",
        coverage: unknownCoverage("verification_failed"),
      };
    input = {
      ...input,
      capture: recordingCaptureProvenanceSchema.parse(input.capture),
    };
    captureState(input);
    // Validate checksums/PCM before starting storage work. Invalid inputs are programmer errors.
    const folder =
      input.previous?.artifactFolder ??
      getRecordingArtifactFolder(input.capture);
    const additions = input.artifacts.map((item) => ({
      item,
      reference: artifactRef(input.capture, item, folder),
    }));
    let previous: RecordingManifest | undefined;
    let coverage = unknownCoverage("verification_failed");
    try {
      if (input.previous) {
        const saved = await readForProducer(input.previous, input.signal);
        previous = saved.manifest;
        coverage = saved.coverage;
        if (producerSession && saved.missing.length)
          return { kind: "preservation_failed", coverage };
      }
    } catch {
      return { kind: "preservation_failed", coverage };
    }
    if (previous && !isDeepStrictEqual(previous.capture, input.capture))
      throw new Error("Checkpoint capture changed");
    const artifacts = mergeArtifacts(
      previous,
      additions.map(({ reference }) => reference),
    );
    let row: MeetingHistory | undefined;
    try {
      row = await repository.getMeetingHistory(
        {
          guildId: input.capture.guildId,
          channelId_timestamp: input.capture.channelId_timestamp,
        },
        input.signal,
      );
    } catch {
      return { kind: "preservation_failed", coverage };
    }
    validateCaptureHistory(row, input.capture);
    try {
      await assertPreservation(proof, input.signal);
      for (const { item, reference } of additions)
        await preserve(
          reference.object,
          item.bytes,
          item.contentType,
          input.signal,
        );
      return await publish(input, artifacts, previous, proof);
    } catch {
      return { kind: "preservation_failed", coverage };
    }
  }
  async function flush(
    input: CheckpointFlushInput,
  ): Promise<CheckpointAppendResult> {
    if (!producerSession) return flushInternal(input);
    if (
      publishing ||
      !input.ownership ||
      (pinnedOwnership &&
        !isDeepStrictEqual(pinnedOwnership, input.ownership)) ||
      (pinnedCapture && !isDeepStrictEqual(pinnedCapture, input.capture)) ||
      (acknowledged && !sameCheckpoint(acknowledged.checkpoint, input.previous))
    )
      return {
        kind: "stale_owner",
        coverage: unknownCoverage("verification_failed"),
      };
    pinnedCapture ??= recordingCaptureProvenanceSchema.parse(input.capture);
    pinnedOwnership ??= { ...input.ownership };
    publishing = true;
    try {
      return await flushInternal(input);
    } finally {
      publishing = false;
    }
  }
  async function preserveTerminalRecordingCheckpoint(
    input:
      | TerminalRecordingCheckpointInput
      | InitialTerminalRecordingCheckpointInput,
  ): Promise<CheckpointAppendResult> {
    const remaining = input.preservation.deadlineEpochMs - Date.now();
    if (remaining <= 0 || input.preservation.signal.aborted)
      return {
        kind: "preservation_failed",
        coverage: unknownCoverage("verification_failed"),
      };
    const signal = AbortSignal.any([
      input.preservation.signal,
      AbortSignal.timeout(Math.ceil(remaining)),
    ]);
    return flushInternal({ ...input, signal }, input);
  }
  async function forMeeting(
    meeting: RecordingCheckpointMeeting,
    artifacts: CheckpointArtifactInput[],
    signal?: AbortSignal,
  ): Promise<CheckpointAppendResult> {
    const originalReservation = meeting.reservation;
    if (
      !originalReservation ||
      originalReservation.sessionMode !== "meeting" ||
      !meeting.ownershipSignal
    )
      return {
        kind: "preservation_failed",
        coverage: unknownCoverage("verification_failed"),
      };
    const reservation = { ...originalReservation };
    if (
      meeting.meetingId !== reservation.meetingId ||
      meeting.guildId !== reservation.guildId
    )
      return {
        kind: "stale_owner",
        coverage: unknownCoverage("verification_failed"),
      };
    const effectiveSignal = signal
      ? AbortSignal.any([signal, meeting.ownershipSignal])
      : meeting.ownershipSignal;
    if (effectiveSignal.aborted)
      return {
        kind: "stale_owner",
        coverage: unknownCoverage("verification_failed"),
      };
    let row: MeetingHistory | undefined;
    try {
      row = await repository.getMeetingHistory(
        reservation.historyKey,
        effectiveSignal,
      );
    } catch {
      return {
        kind: "preservation_failed",
        coverage: unknownCoverage("verification_failed"),
      };
    }
    if (
      !row?.status ||
      row.ownerInstanceId !== reservation.ownerInstanceId ||
      row.executionVersion !== reservation.executionVersion
    )
      return {
        kind: "stale_owner",
        coverage: unknownCoverage("verification_failed"),
      };
    const result = await flush({
      ownership: {
        guildId: reservation.guildId,
        meetingId: reservation.meetingId,
        ownerInstanceId: reservation.ownerInstanceId,
        executionVersion: reservation.executionVersion,
        voiceOperationAttemptId: reservation.voiceOperationAttemptId,
        sessionMode: reservation.sessionMode,
      },
      capture: {
        ...reservation.historyKey,
        meetingId: reservation.meetingId,
        channelId: meeting.voiceChannel.id,
        ownerInstanceId: reservation.ownerInstanceId,
        executionVersion: reservation.executionVersion,
        reservedAt: new Date(reservation.reservedAt).toISOString(),
        captureStartedAt: meeting.captureStartedAt?.toISOString() ?? null,
        requested: {
          transcribeMeeting: meeting.transcribeMeeting,
          generateNotes: meeting.generateNotes,
        },
      },
      fixtureInput: fixtureInputSnapshot(meeting),
      captureState: meeting.recordingCaptureState,
      previous: meeting.recordingCheckpoint,
      expectedStatus: row.status,
      artifacts,
      signal: effectiveSignal,
    });
    if (result.kind === "committed")
      meeting.recordingCheckpoint = result.checkpoint;
    return result;
  }
  function appendRecordingCheckpoint(
    meeting: RecordingCheckpointMeeting,
    segment: CheckpointSegmentInput,
  ) {
    const coverage: RecordingCoverage =
      segment.startOffsetMs === null
        ? { kind: "unknown" }
        : {
            kind: "known",
            intervals: [
              {
                sourceId: segment.sourceId,
                startOffsetMs: segment.startOffsetMs,
                durationMs: segment.durationMs,
              },
            ],
          };
    return forMeeting(meeting, [
      {
        kind: "audio",
        sourceId: segment.sourceId,
        sequence: segment.sequence,
        format: segment.format,
        contentType: "application/octet-stream",
        coverage,
        bytes: segment.bytes,
        checksumSha256: segment.checksumSha256,
      },
    ]);
  }
  async function flushRecordingCheckpoint(
    meeting: RecordingCheckpointMeeting,
    options: { signal: AbortSignal },
  ) {
    return (await forMeeting(meeting, [], options.signal)).coverage;
  }
  return {
    flush,
    appendArtifactsRecordingCheckpoint: forMeeting,
    createProducerSession: () =>
      createRecordingCheckpointService(dependencies, true),
    preserveTerminalRecordingCheckpoint: (
      input: TerminalRecordingCheckpointInput,
    ) => preserveTerminalRecordingCheckpoint(input),
    preserveInitialTerminalRecordingCheckpoint: (
      input: InitialTerminalRecordingCheckpointInput,
    ) => preserveTerminalRecordingCheckpoint(input),
    append: (
      input: Omit<CheckpointFlushInput, "artifacts"> & {
        artifact: CheckpointArtifactInput;
      },
    ) => flush({ ...input, artifacts: [input.artifact] }),
    readMetadata: loadManifest,
    read,
    readVerifiedObject: verifiedBytes,
    appendRecordingCheckpoint,
    flushRecordingCheckpoint,
  };
}
export function appendRecordingCheckpoint(
  meeting: MeetingData,
  segment: CheckpointSegmentInput,
): Promise<CheckpointAppendResult> {
  return createRecordingCheckpointService().appendRecordingCheckpoint(
    meeting,
    segment,
  );
}
export function flushRecordingCheckpoint(
  meeting: MeetingData,
  options: { signal: AbortSignal },
): Promise<CaptureCoverage> {
  return createRecordingCheckpointService().flushRecordingCheckpoint(
    meeting,
    options,
  );
}

export function preserveTerminalRecordingCheckpoint(
  input: TerminalRecordingCheckpointInput,
): Promise<CheckpointAppendResult> {
  return createRecordingCheckpointService().preserveTerminalRecordingCheckpoint(
    input,
  );
}

const producerSessions = new WeakMap<
  MeetingData,
  ReturnType<typeof createRecordingCheckpointService>
>();
export function appendMeetingCheckpointArtifacts(
  meeting: MeetingData,
  artifacts: readonly CheckpointArtifactInput[],
  signal: AbortSignal,
) {
  let session = producerSessions.get(meeting);
  if (!session) {
    session = createRecordingCheckpointService().createProducerSession();
    producerSessions.set(meeting, session);
  }
  return session.appendArtifactsRecordingCheckpoint(
    meeting,
    [...artifacts],
    signal,
  );
}
