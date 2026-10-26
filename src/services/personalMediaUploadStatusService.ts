import { getDeploymentControlRepository } from "../db";
import { getPersonalMediaUploadRepository } from "../repositories/personalMediaUploadRepository";
import {
  getPausedDesktopDraft,
  requireUnpausedDesktopDraft,
  PausedDesktopDraftError,
} from "../repositories/pausedDesktopDraft";
import type { PersonalMediaUploadJobRecord } from "../types/db";

export class PersonalMediaUploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsupported_type"
      | "too_large"
      | "signing_failed"
      | "not_found"
      | "forbidden"
      | "expired"
      | "invalid_token"
      | "missing_object"
      | "storage_unavailable"
      | "invalid_state"
      | "paused",
  ) {
    super(message);
  }
}

export type PersonalMediaUploadStatus = Omit<
  PersonalMediaUploadJobRecord,
  "status"
> & {
  status: PersonalMediaUploadJobRecord["status"] | "paused";
};

async function getOwnedPersonalMediaUploadJob(options: {
  uploadId: string;
  userId: string;
}): Promise<PersonalMediaUploadJobRecord> {
  const job = await getPersonalMediaUploadRepository().get(options.uploadId);
  if (!job) {
    throw new PersonalMediaUploadError("Upload not found.", "not_found");
  }
  if (job.ownerUserId !== options.userId) {
    throw new PersonalMediaUploadError("Upload not found.", "forbidden");
  }
  return job;
}

export async function requireUnpausedPersonalMediaUpload(
  job: Pick<PersonalMediaUploadJobRecord, "uploadId" | "ownerUserId">,
): Promise<void> {
  try {
    await requireUnpausedDesktopDraft(getDeploymentControlRepository(), job);
  } catch (error) {
    if (error instanceof PausedDesktopDraftError)
      throw new PersonalMediaUploadError(error.message, error.code);
    throw error;
  }
}

export async function getUnpausedPersonalMediaUploadJobForUser(options: {
  uploadId: string;
  userId: string;
}): Promise<PersonalMediaUploadJobRecord> {
  const job = await getOwnedPersonalMediaUploadJob(options);
  await requireUnpausedPersonalMediaUpload(job);
  return job;
}

export async function getPersonalMediaUploadJobForUser(options: {
  uploadId: string;
  userId: string;
}): Promise<PersonalMediaUploadStatus> {
  const job = await getOwnedPersonalMediaUploadJob(options);
  if (await getPausedDesktopDraft(getDeploymentControlRepository(), job))
    return {
      ...job,
      status: "paused",
      retryable: false,
      errorMessage: new PausedDesktopDraftError().message,
    };
  return job;
}
