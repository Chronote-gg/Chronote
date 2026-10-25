import { z } from "zod";
import type {
  MeetingHistory,
  PersonalMediaClaim,
  PersonalMediaUploadJobRecord,
} from "./db";
import { originalPublicationUnsettled } from "./meetingPublication";

const identity = z.string().min(1).max(512);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const canonicalWriterSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("recording"),
      ownerInstanceId: identity,
      executionVersion: version,
    })
    .strict(),
  z
    .object({
      kind: z.literal("personal"),
      uploadId: identity,
      instanceId: identity,
      attempt: version,
      claimId: identity,
    })
    .strict(),
]);
export type CanonicalWriter = z.infer<typeof canonicalWriterSchema>;

// Old recording cancellation may still finish with a cancelled -> cancelled write.
export function canonicalWriterRequiresAdmission(row: MeetingHistory): boolean {
  return (
    originalPublicationUnsettled(row) ||
    (row.status === "cancelled" && Boolean(row.ownerInstanceId))
  );
}
export function canonicalWriterAllowsEdit(row: MeetingHistory): boolean {
  if (!canonicalWriterRequiresAdmission(row)) return true;
  const writer = row.canonicalWriter;
  if (!writer) return false;
  if (row.ownershipScope === "personal") return writer.kind === "personal";
  return (
    writer.kind === "recording" &&
    writer.ownerInstanceId === row.ownerInstanceId &&
    writer.executionVersion === row.executionVersion
  );
}
export function personalCanonicalWriter(
  claim: PersonalMediaClaim,
): Extract<CanonicalWriter, { kind: "personal" }> {
  return {
    kind: "personal",
    uploadId: claim.uploadId,
    instanceId: claim.instanceId,
    attempt: claim.attempt,
    claimId: claim.claimId,
  };
}
export function canonicalPersonalClaim(
  row: MeetingHistory,
  now: number,
): PersonalMediaClaim | undefined {
  const writer = row.canonicalWriter;
  if (!canonicalWriterRequiresAdmission(row) || writer?.kind !== "personal")
    return undefined;
  return {
    uploadId: writer.uploadId,
    instanceId: writer.instanceId,
    attempt: writer.attempt,
    claimId: writer.claimId,
    nowEpochSeconds: now,
  };
}
export function personalClaimMatches(
  job: PersonalMediaUploadJobRecord | undefined,
  claim: PersonalMediaClaim,
): boolean {
  return Boolean(
    job &&
    job.status === "processing" &&
    job.processingOwnerInstanceId === claim.instanceId &&
    job.processingClaimId === claim.claimId &&
    job.attempts === claim.attempt &&
    job.claimExpiresAt !== undefined &&
    job.claimExpiresAt >= claim.nowEpochSeconds,
  );
}
