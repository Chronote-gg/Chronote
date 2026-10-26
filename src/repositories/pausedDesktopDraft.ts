import type { PersonalMediaUploadJobRecord } from "../types/db";
import {
  pausedDesktopDraftKey,
  pausedDesktopDraftRecordSchema,
} from "../types/deploymentControl";
import type { DeploymentControlRepository } from "./deploymentControlRepository";
import { getMockStore } from "./mockStore";

export function mockDesktopDraftPaused(uploadId: string): boolean {
  const { pk, sk } = pausedDesktopDraftKey(uploadId);
  return getMockStore().deploymentControlRecords.has(JSON.stringify([pk, sk]));
}

export class PausedDesktopDraftError extends Error {
  readonly code = "paused";
  constructor() {
    super("This draft is preserved and paused. Recovery is not available yet.");
  }
}
export async function getPausedDesktopDraft(
  repository: Pick<DeploymentControlRepository, "getRecord">,
  job: Pick<PersonalMediaUploadJobRecord, "uploadId" | "ownerUserId">,
) {
  const key = pausedDesktopDraftKey(job.uploadId);
  const row = await repository.getRecord(key.pk, key.sk);
  if (!row) return undefined;
  const marker = pausedDesktopDraftRecordSchema.parse(row);
  if (
    marker.uploadId !== job.uploadId ||
    marker.ownerUserId !== job.ownerUserId
  )
    throw new Error("Paused draft owner or upload binding mismatch");
  return marker;
}
export async function requireUnpausedDesktopDraft(
  repository: Pick<DeploymentControlRepository, "getRecord">,
  job: Pick<PersonalMediaUploadJobRecord, "uploadId" | "ownerUserId">,
): Promise<void> {
  if (await getPausedDesktopDraft(repository, job))
    throw new PausedDesktopDraftError();
}
