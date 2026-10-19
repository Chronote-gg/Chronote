"use strict";
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { z } = require("zod");
const { canonicalHash } = require("./production-manifest.cjs");
const keys = {
  activeMeeting: ["guildId"],
  meetingHistory: ["guildId", "channelId_timestamp"],
  meetingControl: ["requestId"],
  personalJob: ["uploadId"],
  personalSegment: ["uploadId", "segmentKey"],
  notion: ["pk", "sk"],
  stripeWebhook: ["eventId"],
  guildSubscription: ["guildId"],
};
const projections = {
  activeMeeting: [
    "guildId",
    "meetingId",
    "ownerInstanceId",
    "executionVersion",
    "voiceOperationAttemptId",
    "recoveryAttemptId",
    "status",
    "leaseExpiresAt",
    "sessionMode",
  ],
  meetingHistory: [
    "guildId",
    "channelId_timestamp",
    "meetingId",
    "ownerInstanceId",
    "executionVersion",
    "status",
    "checkpoint.schemaVersion",
    "checkpoint.revision",
    "checkpoint.manifest.checksumSha256",
    "checkpoint.capture.ownerInstanceId",
    "checkpoint.capture.executionVersion",
    "capture.kind",
    "captureCoverage.kind",
    "captureCoverage.savedDurationMs",
    "captureCoverage.lastConfirmedCaptureAt",
    "recovery.disposition",
    "recovery.stage",
    "recovery.reason",
    "recovery.attempt",
    "recovery.executionVersion",
    "recovery.retry.maxAttempts",
    "recovery.retry.nextAttemptAt",
    "recoveryExport.state",
    "recoveryExport.checkpointRevision",
    "recoveryExport.intentExecutionVersion",
    "completionPolicy.decision",
    "delivery.notes.outcome",
    "delivery.notes.intended",
    "delivery.notes.sent",
    "delivery.summary.outcome",
    "delivery.summary.intended",
    "delivery.summary.sent",
    "endedAt",
    "updatedAt",
  ],
  meetingControl: [
    "requestId",
    "queueStatus",
    "commandType",
    "targetOwnerInstanceId",
    "claimedByInstanceId",
    "claimId",
    "claimExpiresAt",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "input.serverId",
    "input.meetingId",
  ],
  personalJob: [
    "uploadId",
    "ownerUserId",
    "status",
    "attempts",
    "processingClaimId",
    "processingOwnerInstanceId",
    "claimExpiresAt",
    "expiresAt",
    "durationSeconds",
    "segmentCount",
    "uploadedSegmentCount",
    "processedSegmentCount",
    "completedAt",
    "meetingGuildId",
    "meetingId",
    "channelId_timestamp",
  ],
  personalSegment: [
    "uploadId",
    "segmentKey",
    "ownerUserId",
    "sourceId",
    "sequence",
    "status",
    "checksumSha256",
    "durationMillis",
    "uploadedAt",
    "submittedAt",
    "processedAt",
  ],
  notion: [
    "pk",
    "sk",
    "recordType",
    "guildId",
    "channelId_timestamp",
    "status",
    "attemptCount",
    "createdAt",
    "lastAttemptAt",
    "lastExportedAt",
    "notionPageId",
    "exportedNotesVersion",
  ],
  stripeWebhook: [
    "eventId",
    "state",
    "leaseToken",
    "leaseUntil",
    "receivedAt",
    "expiresAt",
  ],
  guildSubscription: [
    "guildId",
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
  ],
};
function projectionExpression(fields) {
  const names = {},
    aliases = new Map();
  const expression = fields
    .map((path) =>
      path
        .split(".")
        .map((part) => {
          if (!aliases.has(part)) {
            const alias = `#p${aliases.size}`;
            aliases.set(part, alias);
            names[alias] = part;
          }
          return aliases.get(part);
        })
        .join("."),
    )
    .join(", ");
  return { ProjectionExpression: expression, ExpressionAttributeNames: names };
}
function metadataOnly(record, fields) {
  const result = {};
  for (const path of fields) {
    const parts = path.split(".");
    let value = record;
    for (const part of parts) value = value?.[part];
    if (value === undefined) continue;
    z.union([
      z.string().max(1024),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(z.string().max(1024)).max(100),
    ]).parse(value);
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  return result;
}
function collectMetadataItems(items, category, seenKeys) {
  return items.map((item) => {
    const metadata = metadataOnly(unmarshall(item), projections[category]);
    const key = Object.fromEntries(
      keys[category].map((field) => [
        field,
        z.string().min(1).parse(metadata[field]),
      ]),
    );
    const keyHash = canonicalHash(key);
    if (seenKeys.has(keyHash)) throw new Error("metadata_duplicate");
    seenKeys.add(keyHash);
    return { table: category, key, metadata };
  });
}
async function scanMetadataTable(category, table, read, snapshot) {
  const seenKeys = new Set(),
    tokens = new Set();
  let lastKey;
  z.string().min(1).parse(table);
  do {
    const page = await read("scan", {
      TableName: table,
      ConsistentRead: true,
      ...projectionExpression(projections[category]),
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    });
    if (!Array.isArray(page?.Items)) throw new Error("metadata_missing");
    snapshot.records.push(
      ...collectMetadataItems(page.Items, category, seenKeys),
    );
    lastKey = page.LastEvaluatedKey;
    if (lastKey) {
      const token = canonicalHash(lastKey);
      if (
        !Object.keys(lastKey).length ||
        tokens.has(token) ||
        tokens.size >= 10000
      )
        throw new Error("metadata_pagination");
      tokens.add(token);
    }
  } while (lastKey);
}
async function readRetainedMetadata({ tables, read, now }) {
  const snapshot = { observedAt: now, coverage: [], records: [] };
  for (const category of Object.keys(projections)) {
    try {
      await scanMetadataTable(category, tables[category], read, snapshot);
      snapshot.coverage.push({ table: category, status: "enumerated" });
    } catch {
      snapshot.coverage.push({ table: category, status: "incomplete" });
    }
  }
  return snapshot;
}
const dispositionSchema = z
  .object({
    schemaVersion: z.literal(1),
    predicate: z.literal("missing-owner-or-version-v1"),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    records: z.array(
      z
        .object({
          keyHash: z.string(),
          metadataHash: z.string(),
          disposition: z.literal("preserve_nonadoptable_legacy"),
        })
        .strict(),
    ),
  })
  .strict();
function reviewedLegacy(entry, snapshot, review) {
  const r = entry.metadata;
  // isRecordingRecoveryCandidate refuses any history without an owner or execution version.
  if (r.ownerInstanceId && r.executionVersion) return false;
  if (r.recovery || r.recoveryExport || r.delivery) return false;
  const linked = snapshot.records.some(
    (other) =>
      other !== entry &&
      other.table !== "meetingHistory" &&
      (other.metadata.guildId === r.guildId ||
        other.metadata.meetingGuildId === r.guildId ||
        other.metadata.input?.serverId === r.guildId),
  );
  return (
    !linked &&
    Boolean(
      review?.records.some(
        (d) =>
          d.keyHash === canonicalHash(entry.key) &&
          d.metadataHash === canonicalHash(r),
      ),
    )
  );
}
function historyCategory(entry, snapshot, review) {
  const r = entry.metadata;
  if (
    r.recoveryExport?.state === "submitted" ||
    r.recovery?.disposition === "needs_reconciliation"
  )
    return "uncertain_external_effect";
  if (!r.checkpoint)
    return reviewedLegacy(entry, snapshot, review)
      ? "preserved_nonadoptable_legacy"
      : "interrupted_legacy";
  if (
    r.recovery?.disposition === "done" &&
    ["complete", "cancelled"].includes(r.status) &&
    !["pending", "submitted"].includes(r.recoveryExport?.state) &&
    ["notes", "summary"].every(
      (kind) =>
        !r.delivery?.[kind] ||
        [
          "complete",
          "not_applicable",
          "edited_existing",
          "sent_fallback",
        ].includes(r.delivery[kind].outcome),
    )
  )
    return "safe_terminal";
  return r.checkpoint.schemaVersion === 1
    ? "compatible_work_requires_review"
    : "unknown_metadata";
}
function recoveryBillingCategory(r) {
  if (
    r.state === "ended" ||
    (["paid", "superseded"].includes(r.state) &&
      r.projection?.state === "complete")
  )
    return "safe_terminal";
  if (
    r.state === "canceled" &&
    r.receipts?.canceled === true &&
    r.receipts?.collectionRestored === true &&
    Array.isArray(r.receipts.collectionToRestore)
  )
    return "safe_terminal";
  return "uncertain_external_effect";
}
function billingCategory(r) {
  if (r.guildId.startsWith("CHANGE_OP#"))
    return ["succeeded", "canceled"].includes(r.state) && r.reconciled === true
      ? "safe_terminal"
      : "uncertain_external_effect";
  if (r.guildId.startsWith("RENEWAL_OP#"))
    return ["succeeded", "rejected"].includes(r.state)
      ? "safe_terminal"
      : "uncertain_external_effect";
  if (r.guildId.startsWith("RENEWAL_RECOVERY#"))
    return recoveryBillingCategory(r);
  return /^\d{17,20}$/.test(r.guildId)
    ? "preserved_configuration"
    : "unknown_metadata";
}
function personalJobCategory(r) {
  if (r.status === "complete" && r.completedAt && !r.processingClaimId)
    return "safe_terminal";
  return r.status === "pending_upload"
    ? "late_upload_exposure"
    : "unsettled_claim_control";
}
function notionCategory(r) {
  if (["connection", "automation_config"].includes(r.recordType))
    return "preserved_configuration";
  if (
    ["meeting_export", "automation_export"].includes(r.recordType) &&
    r.notionPageId &&
    r.lastExportedAt &&
    (r.recordType === "meeting_export" || r.status === "exported")
  )
    return "safe_terminal";
  return "uncertain_external_effect";
}
const classifiers = {
  activeMeeting: () => "unsettled_claim_control",
  meetingControl: (r) =>
    ["completed", "failed"].includes(r.queueStatus)
      ? "safe_terminal"
      : "unsettled_claim_control",
  personalJob: personalJobCategory,
  personalSegment: (r) =>
    r.status === "processed" && r.processedAt
      ? "safe_terminal"
      : "late_upload_exposure",
  stripeWebhook: (r) =>
    r.state === "completed"
      ? "safe_terminal"
      : r.state === "processing"
        ? "uncertain_external_effect"
        : "unknown_metadata",
  notion: notionCategory,
  guildSubscription: billingCategory,
};
function categoryFor(entry, snapshot, review) {
  if (entry.table === "meetingHistory")
    return historyCategory(entry, snapshot, review);
  return classifiers[entry.table]?.(entry.metadata) ?? "unknown_metadata";
}
function classifyRetainedWork(snapshot, reviewedDisposition) {
  const review = dispositionSchema.safeParse(reviewedDisposition);
  const records = snapshot.records.map((entry) => ({
    table: entry.table,
    key: entry.key,
    category: categoryFor(
      entry,
      snapshot,
      review.success ? review.data : undefined,
    ),
    metadataHash: canonicalHash(entry.metadata),
  }));
  const reopeningBlockers = [];
  if (
    Object.keys(projections).some(
      (table) =>
        !snapshot.coverage.some(
          (c) => c.table === table && c.status === "enumerated",
        ),
    )
  )
    reopeningBlockers.push("metadata_incomplete");
  for (const record of records)
    if (
      ![
        "safe_terminal",
        "preserved_configuration",
        "preserved_nonadoptable_legacy",
      ].includes(record.category)
    )
      reopeningBlockers.push(record.category);
  return {
    preservesData: true,
    observedAt: snapshot.observedAt,
    records,
    reopeningBlockers,
  };
}
module.exports = { readRetainedMetadata, classifyRetainedWork, projections };
