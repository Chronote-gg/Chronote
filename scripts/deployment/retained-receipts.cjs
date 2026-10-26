"use strict";
const { z } = require("zod");
const { canonicalHash } = require("./production-manifest.cjs");
const receiptBoundary = "stripe-receipt-admission-v1";
const receiptProjectionVersion = "stripe-receipt-metadata-v1";
const receiptProjections = [
  "eventId",
  "state",
  "leaseToken",
  "leaseUntil",
  "receivedAt",
  "expiresAt",
  "birth.version",
  "birth.writer.kind",
  "birth.writer.instanceId",
  "birth.writer.protocolVersion",
  "birth.writer.taskArn",
  "birth.writer.imageDigest",
  "birth.writer.candidateId",
  "birth.writer.localId",
  "birth.hold.holdId",
  "birth.hold.introductionId",
  "birth.hold.revision",
  "continuation",
  "firstAdmission",
  "admission",
];
const id = z.string().min(1);
const ecsWriter = z
  .object({
    kind: z.literal("ecs"),
    instanceId: id,
    protocolVersion: z.literal(1),
    taskArn: id,
    imageDigest: id,
    candidateId: id,
  })
  .strict();
const hold = z
  .object({
    holdId: id,
    introductionId: id,
    revision: z.number().int().positive(),
  })
  .strict();
const sourceCommit = z.string().regex(/^[a-f0-9]{40}$/);
// This schema describes Task7's required evidence binding, never its authenticity.
const receiptWriterClosureContract = z
  .object({
    predicate: z.literal(receiptBoundary),
    projection: z.literal(receiptProjectionVersion),
    consumerSourceCommit: sourceCommit,
    ownershipEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedDispositionHash: z.string().regex(/^[a-f0-9]{64}$/),
    hold,
    writers: z
      .array(z.object({ identity: ecsWriter, sourceCommit }).strict())
      .min(1),
  })
  .strict();
const birth = z
  .object({ version: z.literal(receiptBoundary), writer: ecsWriter, hold })
  .strict();
/** Pure compatibility predicate. A matching result is not permission to reopen. */
function preservedUnadmittedReceipt(metadata, binding) {
  const proof = receiptWriterClosureContract.safeParse(binding);
  const origin = birth.safeParse(metadata.birth);
  if (!proof.success || !origin.success) return "unknown_metadata";
  if (
    metadata.state !== "processing" ||
    metadata.continuation !== "not_admitted" ||
    metadata.firstAdmission !== undefined ||
    metadata.admission !== undefined ||
    metadata.expiresAt !== undefined
  )
    return "uncertain_external_effect";
  const matches =
    canonicalHash(origin.data.hold) === canonicalHash(proof.data.hold) &&
    proof.data.writers.some(
      (writer) =>
        writer.sourceCommit === proof.data.consumerSourceCommit &&
        canonicalHash(writer.identity) === canonicalHash(origin.data.writer),
    );
  return matches ? "preserved_unadmitted_receipt" : "unknown_metadata";
}
module.exports = {
  receiptBoundary,
  receiptProjectionVersion,
  receiptProjections,
  receiptWriterClosureContract,
  preservedUnadmittedReceipt,
};
