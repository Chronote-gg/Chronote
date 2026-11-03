import { promises as fs } from "node:fs";
import path from "node:path";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/deploymentControl";
import type { ArtifactCleanupReceipt } from "../types/artifactCleanup";
import { getDeploymentControlRepository } from "../db";
import { createCleanupAuthorization } from "./artifactCleanupAuthorization";
import { createRecordingCheckpointService } from "./recordingCheckpointService";
import { verifyStoredArtifact } from "./storageService";
import { getVerifiedMeetingArtifacts } from "./uploadService";
import { meetingArtifactProducers } from "./meetingArtifactProducer";
import { inventoryLocalArtifacts } from "./localArtifactInventory";
import {
  CLEANUP_RECEIPT_FILENAME,
  createCleanupReceipt,
  reconcileCleanupReceipt,
  type CleanupReceiptResult,
} from "./artifactCleanupReceipt";
import { MAX_LOCAL_ARTIFACT_ENTRIES } from "../types/localArtifact";
import type { LocalArtifact } from "../types/localArtifact";
import { hasFileSystemCode } from "../utils/fileSystemError";
import { createArtifactCleanupScheduler } from "./artifactCleanupScheduler";
import { recordLocalArtifactCleanup } from "../metrics";

export type CleanupMeeting = Pick<
  MeetingData,
  "meetingId" | "recordingCheckpoint"
> & {
  reservation?: Pick<
    SessionReservation,
    | "guildId"
    | "meetingId"
    | "ownerInstanceId"
    | "executionVersion"
    | "sessionMode"
    | "historyKey"
  >;
};

export async function removeEmptyArtifactDirectories(
  directory: string,
  budget = { remaining: MAX_LOCAL_ARTIFACT_ENTRIES },
): Promise<void> {
  if (--budget.remaining < 0)
    throw new Error("Empty directory traversal exceeds its bound");
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Cleanup directory is not ordinary");
  for await (const entry of await fs.opendir(directory)) {
    if (entry.isDirectory() && !entry.isSymbolicLink())
      await removeEmptyArtifactDirectories(
        path.join(directory, entry.name),
        budget,
      );
  }
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (!hasFileSystemCode(error, "ENOTEMPTY", "EEXIST")) throw error;
  }
}

export function createLocalArtifactCleanupAuthorization() {
  return createCleanupAuthorization({
    repository: getDeploymentControlRepository(),
    checkpoints: createRecordingCheckpointService(),
    verifyStoredArtifact,
  });
}

async function prepareCleanupReceipt(
  directory: string,
  files: LocalArtifact[],
  meeting?: CleanupMeeting,
) {
  const producer = meetingArtifactProducers.get(directory);
  const reservation = meeting?.reservation;
  if (
    !producer ||
    !reservation ||
    reservation.sessionMode !== "meeting" ||
    !reservation.historyKey
  )
    throw new Error("Local artifacts have no closed provenance receipt");
  const snapshot = producer.freeze();
  if (
    snapshot.owner.ownerInstanceId !== reservation.ownerInstanceId ||
    snapshot.owner.executionVersion !== reservation.executionVersion ||
    snapshot.owner.meetingId !== meeting.meetingId
  )
    throw new Error("Cleanup producer ownership differs");
  const row = await getDeploymentControlRepository().getMeetingHistory(
    reservation.historyKey,
  );
  const receipt: ArtifactCleanupReceipt = {
    version: 1,
    owner: snapshot.owner,
    historyKey: reservation.historyKey.channelId_timestamp,
    createdAt: new Date().toISOString(),
    files,
    producers: snapshot.files,
    storedArtifacts: getVerifiedMeetingArtifacts(meeting),
    checkpoint: meeting.recordingCheckpoint ?? null,
    decision: row?.status === "cancelled" ? "cancel" : "complete",
  };
  await createLocalArtifactCleanupAuthorization()(receipt);
  await createCleanupReceipt(directory, receipt);
}

async function hasCleanupReceipt(directory: string) {
  try {
    await fs.lstat(path.join(directory, CLEANUP_RECEIPT_FILENAME));
    return true;
  } catch (error) {
    if (hasFileSystemCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function reconcileUnregisteredDirectory(
  directory: string,
): Promise<CleanupReceiptResult> {
  await removeEmptyArtifactDirectories(directory);
  try {
    await fs.lstat(directory);
    throw new Error("Local artifacts have no provenance receipt");
  } catch (error) {
    if (!hasFileSystemCode(error, "ENOENT")) throw error;
    return { kind: "cleaned", removed: 0, byteLength: 0 };
  }
}

export async function reconcileMeetingTempDirectory(
  directory: string,
  meeting?: CleanupMeeting,
): Promise<CleanupReceiptResult> {
  try {
    const producer = meetingArtifactProducers.get(directory);
    if (producer?.pendingWrites)
      throw new Error("Local artifact writes remain owned");
    const receiptExists = await hasCleanupReceipt(directory);
    if (!meeting && !receiptExists) {
      if (producer && !producer.closed)
        throw new Error("Local artifact producer remains open");
      return await reconcileUnregisteredDirectory(directory);
    }
    const inventory = await inventoryLocalArtifacts(directory);
    if (!inventory.files.length) {
      if (producer && !producer.closed)
        throw new Error("Local artifact producer remains open");
      await removeEmptyArtifactDirectories(directory);
      meetingArtifactProducers.release(directory);
      return { kind: "cleaned", removed: 0, byteLength: 0 };
    }
    if (!receiptExists) {
      await prepareCleanupReceipt(directory, inventory.files, meeting);
    } else if (producer && !producer.closed) {
      throw new Error("Local artifact producer remains open");
    }
    const result = await reconcileCleanupReceipt(directory, {
      authorize: createLocalArtifactCleanupAuthorization(),
    });
    if (result.kind === "cleaned") {
      await removeEmptyArtifactDirectories(directory);
      meetingArtifactProducers.release(directory);
    }
    return result;
  } catch (error) {
    return { kind: "blocked", error };
  }
}

export const localArtifactCleanup = createArtifactCleanupScheduler({
  reconcile: reconcileMeetingTempDirectory,
  observe: recordLocalArtifactCleanup,
});
