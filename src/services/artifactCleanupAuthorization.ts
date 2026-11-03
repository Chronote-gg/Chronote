import { isDeepStrictEqual } from "node:util";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import type { MeetingHistory } from "../types/db";
import {
  artifactCleanupReceiptSchema,
  type ArtifactCleanupReceipt,
  type ArtifactProvenance,
  type RegisteredArtifact,
} from "../types/artifactCleanup";
import type { LocalArtifact } from "../types/localArtifact";
import {
  recordingCheckpointSchema,
  recordingCaptureProvenanceSchema,
} from "../types/recordingCheckpoint";
import type { createRecordingCheckpointService } from "./recordingCheckpointService";
import type { verifyStoredArtifact } from "./storageService";

type Checkpoints = Pick<
  ReturnType<typeof createRecordingCheckpointService>,
  "read"
>;
type VerifiedCheckpoint = Awaited<ReturnType<Checkpoints["read"]>>;

function hasCommittedContentReplacement(
  provenance: Extract<ArtifactProvenance, { kind: "content" }>,
  file: LocalArtifact,
  checkpoint: VerifiedCheckpoint | null,
) {
  return (
    sameBytes(provenance, file) &&
    checkpoint?.verified.some(
      (item) =>
        item.kind === provenance.contentKind &&
        item.sourceId === provenance.sourceId &&
        (sameBytes(item.object, file) ||
          (provenance.contentKind !== "audio" &&
            item.sequence > provenance.sequence)),
    )
  );
}

function hasCompleteStoredAudio(
  receipt: ArtifactCleanupReceipt,
  checkpoint: VerifiedCheckpoint | null,
  row: MeetingHistory,
) {
  return (
    checkpoint?.manifest.captureState.kind === "complete" &&
    checkpoint.verified.some((item) => item.kind === "audio") &&
    receipt.storedArtifacts.some((item) => item.key === row.audioS3Key)
  );
}

function requireHistory(
  row: MeetingHistory | undefined,
  receipt: ArtifactCleanupReceipt,
) {
  const { owner } = receipt;
  if (
    !row ||
    row.guildId !== owner.guildId ||
    row.meetingId !== owner.meetingId ||
    row.channelId_timestamp !== receipt.historyKey ||
    row.ownerInstanceId !== owner.ownerInstanceId ||
    row.executionVersion !== owner.executionVersion ||
    !isDeepStrictEqual(
      row.checkpoint ? recordingCheckpointSchema.parse(row.checkpoint) : null,
      receipt.checkpoint,
    )
  )
    throw new Error("Cleanup history ownership changed");
  if (
    receipt.decision !== "scratch" &&
    (receipt.decision === "complete"
      ? row.status !== "complete"
      : row.status !== "cancelled" ||
        row.completionPolicy?.decision !== "cancel")
  )
    throw new Error("Cleanup disposition is not durable");
  return row;
}

function sameBytes(
  a: Pick<LocalArtifact, "byteLength" | "checksumSha256">,
  b: Pick<LocalArtifact, "byteLength" | "checksumSha256">,
) {
  return a.byteLength === b.byteLength && a.checksumSha256 === b.checksumSha256;
}

function requireScratchProvenance(
  receipt: ArtifactCleanupReceipt,
  provenance: ArtifactProvenance,
) {
  if (receipt.decision === "scratch" && provenance.kind !== "stored_derivative")
    throw new Error("Scratch cleanup cannot authorize original capture files");
  if (provenance.kind !== "stored_derivative") return false;
  if (
    receipt.decision !== "scratch" ||
    !provenance.inputs.every((input) =>
      receipt.storedArtifacts.some(
        (stored) => stored.key === input.key && sameBytes(stored, input),
      ),
    )
  )
    throw new Error("Scratch inputs are not verified");
  return true;
}

function requireFileProvenance(
  receipt: ArtifactCleanupReceipt,
  checkpoint: VerifiedCheckpoint | null,
  row: MeetingHistory,
  file: LocalArtifact,
  registered: RegisteredArtifact | undefined,
) {
  if (!registered) throw new Error("Artifact producer is unknown");
  const provenance = registered.provenance;
  if (requireScratchProvenance(receipt, provenance)) return;
  if (registered.state !== "known")
    throw new Error("Artifact producer is unsettled");
  switch (provenance.kind) {
    case "stored_input":
      if (!receipt.storedArtifacts.some((object) => sameBytes(object, file)))
        throw new Error("Local input has no verified stored equivalent");
      return;
    case "metadata":
      if (!sameBytes(provenance, file))
        throw new Error("Local metadata changed");
      return;
    case "content":
      if (!hasCommittedContentReplacement(provenance, file, checkpoint))
        throw new Error("Local snapshot has no committed replacement");
      return;
    case "captured_audio":
      if (
        receipt.decision !== "cancel" &&
        !hasCompleteStoredAudio(receipt, checkpoint, row)
      )
        throw new Error("Local audio has no complete durable capture");
      return;
    case "stored_derivative":
      throw new Error("Scratch provenance was not verified");
  }
}

function allowedArtifactKeys(
  row: MeetingHistory,
  receipt: ArtifactCleanupReceipt,
  checkpoint: VerifiedCheckpoint | null,
) {
  const folder = receipt.checkpoint?.artifactFolder;
  return new Set(
    [
      row.audioS3Key,
      row.chatS3Key,
      row.transcriptS3Key,
      ...(folder ? [`${folder}chat.txt`, `${folder}chat.json`] : []),
      ...(receipt.decision === "scratch"
        ? (checkpoint?.verified.map((item) => item.object.key) ?? [])
        : []),
    ].filter((value) => value !== undefined),
  );
}

function requireProvenance(
  receipt: ArtifactCleanupReceipt,
  checkpoint: VerifiedCheckpoint | null,
  row: MeetingHistory,
) {
  const producers = new Map(
    receipt.producers.map((entry) => [entry.path, entry]),
  );
  if (producers.size !== receipt.producers.length)
    throw new Error("Duplicate artifact producer");
  for (const file of receipt.files) {
    const registered = producers.get(file.path);
    requireFileProvenance(receipt, checkpoint, row, file, registered);
  }
}

async function readCleanupCheckpoint(
  receipt: ArtifactCleanupReceipt,
  checkpoints: Checkpoints,
  signal?: AbortSignal,
) {
  if (!receipt.checkpoint) return null;
  const checkpoint = await checkpoints.read(receipt.checkpoint, signal);
  if (checkpoint.missing.length && receipt.decision !== "scratch")
    throw new Error("Cleanup checkpoint is incomplete");
  if (
    !isDeepStrictEqual(
      receipt.checkpoint.capture,
      recordingCaptureProvenanceSchema.parse(checkpoint.manifest.capture),
    ) ||
    (receipt.decision !== "scratch" &&
      (receipt.checkpoint.capture.ownerInstanceId !==
        receipt.owner.ownerInstanceId ||
        receipt.checkpoint.capture.executionVersion !==
          receipt.owner.executionVersion))
  )
    throw new Error("Cleanup checkpoint ownership differs");
  return checkpoint;
}

export function createCleanupAuthorization(dependencies: {
  repository: Pick<DeploymentControlRepository, "getMeetingHistory">;
  checkpoints: Checkpoints;
  verifyStoredArtifact: typeof verifyStoredArtifact;
}) {
  return async (
    input: ArtifactCleanupReceipt,
    signal?: AbortSignal,
  ): Promise<void> => {
    const receipt = artifactCleanupReceiptSchema.parse(input);
    const key = {
      guildId: receipt.owner.guildId,
      channelId_timestamp: receipt.historyKey,
    };
    const row = requireHistory(
      await dependencies.repository.getMeetingHistory(key, signal),
      receipt,
    );
    const checkpoint = await readCleanupCheckpoint(
      receipt,
      dependencies.checkpoints,
      signal,
    );
    const allowedKeys = allowedArtifactKeys(row, receipt, checkpoint);
    for (const reference of receipt.storedArtifacts) {
      if (!allowedKeys.has(reference.key))
        throw new Error("Cleanup object is not bound to saved history");
      await dependencies.verifyStoredArtifact(reference, signal);
    }
    requireProvenance(receipt, checkpoint, row);
    const latest = requireHistory(
      await dependencies.repository.getMeetingHistory(key, signal),
      receipt,
    );
    if (
      latest.audioS3Key !== row.audioS3Key ||
      latest.chatS3Key !== row.chatS3Key ||
      latest.transcriptS3Key !== row.transcriptS3Key
    )
      throw new Error("Cleanup history artifacts changed");
    signal?.throwIfAborted();
  };
}
