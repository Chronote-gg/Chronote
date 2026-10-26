"use strict";
const { z } = require("zod");
const { canonicalHash } = require("./production-manifest.cjs");
const id = z.string().min(1),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().int().nonnegative();
const billingProjections = [
  "guildId",
  "ownerGuildId",
  "operationId",
  "revision",
  "state",
  "reconciled",
  "completedAt",
  "appliedAt",
  "nextCheckAt",
  "projection.state",
  "projection.nextCheckAt",
  "receipts.canceled",
  "receipts.collectionRestored",
  "receipts.collectionToRestore",
  "receipts.creditNoteId",
  "receipts.refundIds",
  "key",
  "blocking",
  "subscriptionId",
  "customerId",
  "payerId",
  "mode",
  "enforcementAccepted",
  "scheduledOperationId",
  "paid.invoiceId",
  "paid.priceId",
  "paid.tier",
  "paid.interval",
  "paid.periodStart",
  "paid.periodEnd",
  "writerVersion",
  "writerRuntime.taskArn",
  "writerRuntime.imageDigest",
  "recoveryQueue",
  "recoveryDueAt",
  "stripeSubscriptionId",
  "stripeCustomerId",
  "stripeSyncRevision",
  "timing",
  "scheduleId",
  "providerScheduleId",
  "source.subscriptionId",
  "source.customerId",
  "source.periodStart",
  "source.periodEnd",
  "source.revision",
  "source.fingerprint",
  "source.invariantFingerprint",
  "consent.at",
  "consent.quoteRevision",
  "target.selection.tier",
  "target.selection.interval",
  "target.priceId",
];
const futureReviewSchema = z
  .object({
    predicate: z.literal("billing-future-v1"),
    projection: z.literal("billing-metadata-v1"),
    consumerSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    ownershipEvidenceHash: hash,
    records: z.array(
      z
        .object({
          keyHash: hash,
          metadataHash: hash,
          relatedMetadataHash: hash,
          scheduleAcknowledgment: z
            .object({
              scheduleId: id,
              operationId: z.uuid(),
              receiptHash: hash,
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
function billingIdentity(r) {
  const match =
    /^(CHANGE_OP|CHANGE_CONTROL|RENEWAL_OP|RENEWAL_CONTROL|RENEWAL_RECOVERY|RENEWAL_RECOVERY_CURRENT)#(\d{17,20})(?:#(.+))?$/.exec(
      r.guildId,
    );
  return match && { family: match[1], guild: match[2], suffix: match[3] };
}
function billingRows(snapshot) {
  return snapshot.records.filter((e) => e.table === "guildSubscription");
}
function findRow(snapshot, key) {
  return billingRows(snapshot).find((e) => e.metadata.guildId === key);
}
function reviewFor(entry, snapshot, review) {
  const relatedMetadataHash = canonicalHash(
    billingRows(snapshot)
      .map((e) => ({ key: e.key, metadata: e.metadata }))
      .sort((a, b) => a.key.guildId.localeCompare(b.key.guildId)),
  );
  return review?.records.find(
    (r) =>
      r.keyHash === canonicalHash(entry.key) &&
      r.metadataHash === canonicalHash(entry.metadata) &&
      r.relatedMetadataHash === relatedMetadataHash,
  );
}
function bindFutureReview(review, binding) {
  const future = review?.compatibleFuture;
  return future &&
    binding?.consumerSourceCommit === future.consumerSourceCommit &&
    binding.ownershipEvidenceHash === future.ownershipEvidenceHash &&
    binding.reviewedDispositionHash === canonicalHash(review)
    ? future
    : undefined;
}
const recoveryIdentitySchema = z.object({
  ownerGuildId: z.string().regex(/^\d{17,20}$/),
  subscriptionId: id,
  customerId: id,
  payerId: id,
  mode: z.enum(["test", "live"]),
  revision: id,
  paid: z
    .object({
      invoiceId: id,
      priceId: id,
      tier: z.enum(["basic", "pro"]),
      interval: z.enum(["month", "year"]),
      periodStart: seconds,
      periodEnd: seconds,
    })
    .strict()
    .refine((p) => p.periodEnd > p.periodStart),
  scheduledOperationId: id.nullable(),
  enforcementAccepted: z.boolean(),
});
function validRecoveryIdentity(r) {
  return (
    recoveryIdentitySchema.safeParse(r).success &&
    r.guildId ===
      `RENEWAL_RECOVERY#${r.ownerGuildId}#${r.subscriptionId}#${r.paid.periodEnd}`
  );
}
function recoveryTerminal(r) {
  if (!validRecoveryIdentity(r)) return false;
  if (r.state === "ended")
    return (
      r.nextCheckAt === undefined &&
      r.recoveryDueAt === undefined &&
      r.recoveryQueue === undefined
    );
  if (["paid", "superseded"].includes(r.state))
    return r.projection?.state === "complete";
  return (
    r.state === "canceled" &&
    r.receipts?.canceled === true &&
    r.receipts?.collectionRestored === true &&
    Array.isArray(r.receipts.collectionToRestore)
  );
}
const currentSchema = z
  .object({ guildId: id, key: id, revision: id, blocking: z.literal(false) })
  .strict();
function matchingCurrent(snapshot, r) {
  const pointer = findRow(
    snapshot,
    `RENEWAL_RECOVERY_CURRENT#${r.ownerGuildId}`,
  )?.metadata;
  return (
    currentSchema.safeParse(pointer).success &&
    pointer.key === r.guildId &&
    pointer.revision === r.revision &&
    pointer.blocking === false
  );
}
function matchingSubscription(snapshot, guild, subscription, customer) {
  const pointer = findRow(snapshot, guild)?.metadata;
  return (
    pointer?.stripeSubscriptionId === subscription &&
    pointer.stripeCustomerId === customer
  );
}
const watchWriterSchema = z.object({
  writerVersion: z.literal("renewal-grace-v1"),
  writerRuntime: z
    .object({
      taskArn: z.string().regex(/^arn:[^:]+:ecs:[^:]+:\d{12}:task\/.+$/),
      imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
});
const watchSchema = recoveryIdentitySchema
  .extend({
    guildId: id,
    ...watchWriterSchema.shape,
    state: z.literal("watching"),
    enforcementAccepted: z.literal(false),
    scheduledOperationId: z.null(),
    nextCheckAt: seconds,
    recoveryDueAt: seconds,
    recoveryQueue: z.enum(["test", "live"]),
  })
  .strict();
function passiveWatch(r, snapshot) {
  return (
    validRecoveryIdentity(r) &&
    watchSchema.safeParse(r).success &&
    r.nextCheckAt === r.paid.periodEnd &&
    r.recoveryDueAt === r.nextCheckAt &&
    r.recoveryQueue === r.mode &&
    r.nextCheckAt > snapshot.observedAt &&
    matchingCurrent(snapshot, r) &&
    matchingSubscription(
      snapshot,
      r.ownerGuildId,
      r.subscriptionId,
      r.customerId,
    ) &&
    !findRow(snapshot, `RENEWAL_CONTROL#${r.ownerGuildId}`)
  );
}
const scheduledSchema = z
  .object({
    guildId: id,
    operationId: z.uuid(),
    revision: id,
    payerId: id,
    mode: z.enum(["test", "live"]),
    state: z.literal("scheduled"),
    timing: z.literal("renewal"),
    scheduleId: id,
    consent: z.object({ at: seconds, quoteRevision: id }).strict(),
    source: z
      .object({
        subscriptionId: id,
        customerId: id,
        periodStart: seconds,
        periodEnd: seconds,
        revision: id.nullable(),
        fingerprint: id,
        invariantFingerprint: id,
      })
      .strict(),
    target: z
      .object({
        selection: z
          .object({
            tier: z.enum(["basic", "pro"]),
            interval: z.enum(["month", "year"]),
          })
          .strict(),
        priceId: id,
      })
      .strict(),
  })
  .strict();
function scheduledWatchMatches(r, snapshot, guild) {
  const current = findRow(
    snapshot,
    `RENEWAL_RECOVERY_CURRENT#${guild}`,
  )?.metadata;
  const watch = current && findRow(snapshot, current.key)?.metadata;
  return (
    watch &&
    passiveWatch(watch, snapshot) &&
    watch.subscriptionId === r.source.subscriptionId &&
    watch.paid.periodEnd === r.source.periodEnd &&
    watch.mode === r.mode &&
    watch.payerId === r.payerId
  );
}
const changeControlSchema = z
  .object({ guildId: id, operationId: z.uuid() })
  .strict();
function scheduledFuture(r, snapshot, reviewed) {
  if (!scheduledSchema.safeParse(r).success) return false;
  const identity = billingIdentity(r);
  const control = findRow(
    snapshot,
    `CHANGE_CONTROL#${identity.guild}`,
  )?.metadata;
  const ack = reviewed.scheduleAcknowledgment;
  return (
    identity.suffix === r.operationId &&
    changeControlSchema.safeParse(control).success &&
    control.operationId === r.operationId &&
    r.source.periodEnd > snapshot.observedAt &&
    r.source.periodEnd > r.source.periodStart &&
    matchingSubscription(
      snapshot,
      identity.guild,
      r.source.subscriptionId,
      r.source.customerId,
    ) &&
    scheduledWatchMatches(r, snapshot, identity.guild) &&
    ack?.scheduleId === r.scheduleId &&
    ack.operationId === r.operationId
  );
}
function futureCategory(entry, snapshot, review) {
  const reviewed = reviewFor(entry, snapshot, review);
  if (!reviewed) return "compatible_work_requires_review";
  const r = entry.metadata;
  const compatible =
    r.state === "watching"
      ? passiveWatch(r, snapshot)
      : scheduledFuture(r, snapshot, reviewed);
  return compatible
    ? "preserved_compatible_future"
    : "uncertain_external_effect";
}
function operationCategory(entry, snapshot, review, identity) {
  const r = entry.metadata;
  if (!id.safeParse(r.revision).success || identity.suffix !== r.operationId)
    return "unknown_metadata";
  if (identity.family === "CHANGE_OP") {
    if (["succeeded", "canceled"].includes(r.state) && r.reconciled === true)
      return "safe_terminal";
    if (r.state === "scheduled") return futureCategory(entry, snapshot, review);
  }
  if (
    identity.family === "RENEWAL_OP" &&
    ["succeeded", "rejected"].includes(r.state)
  )
    return "safe_terminal";
  return "uncertain_external_effect";
}
function currentCategory(r, snapshot, review, identity) {
  const target = findRow(snapshot, r.key);
  if (
    identity.suffix ||
    !target ||
    !currentSchema.safeParse(r).success ||
    r.revision !== target.metadata.revision ||
    target.metadata.ownerGuildId !== identity.guild ||
    !validRecoveryIdentity(target.metadata)
  )
    return "unknown_metadata";
  return billingCategory(target, snapshot, review);
}
function controlCategory(r, snapshot, review, identity) {
  const family =
    identity.family === "CHANGE_CONTROL" ? "CHANGE_OP" : "RENEWAL_OP";
  const target = findRow(
    snapshot,
    `${family}#${identity.guild}#${r.operationId}`,
  );
  const schema =
    family === "CHANGE_OP"
      ? changeControlSchema
      : changeControlSchema.extend({ revision: id });
  if (identity.suffix || !target || !schema.safeParse(r).success)
    return "unknown_metadata";
  // Controls are deleted atomically on terminal settlement; renewal revision remains the original claim's.
  const category = billingCategory(target, snapshot, review);
  return family === "CHANGE_OP" && category === "preserved_compatible_future"
    ? category
    : "unsettled_claim_control";
}
function billingCategory(entry, snapshot, review) {
  const r = entry.metadata,
    identity = billingIdentity(r);
  if (!identity)
    return /^\d{17,20}$/.test(r.guildId)
      ? "preserved_configuration"
      : "unknown_metadata";
  if (["CHANGE_OP", "RENEWAL_OP"].includes(identity.family))
    return operationCategory(entry, snapshot, review, identity);
  if (identity.family === "RENEWAL_RECOVERY_CURRENT")
    return currentCategory(r, snapshot, review, identity);
  if (identity.family.endsWith("_CONTROL"))
    return controlCategory(r, snapshot, review, identity);
  if (recoveryTerminal(r)) return "safe_terminal";
  return r.state === "watching"
    ? futureCategory(entry, snapshot, review)
    : "uncertain_external_effect";
}
module.exports = {
  billingProjections,
  futureReviewSchema,
  bindFutureReview,
  billingCategory,
};
