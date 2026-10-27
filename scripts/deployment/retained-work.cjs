"use strict";
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { z } = require("zod");
const { canonicalHash } = require("./production-manifest.cjs");
const {
  billingProjections,
  futureReviewSchema,
  bindFutureReview,
  billingCategory,
} = require("./retained-billing.cjs");
const { receiptProjections } = require("./retained-receipts.cjs");
const safeCategories = [
  "safe_terminal",
  "preserved_configuration",
  "preserved_nonadoptable_legacy",
  "preserved_compatible_future",
];
const publicationParents = [
  "updateDelivery",
  "publicationRepair",
  "contentMutation",
];
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
    "contentRevision",
    "contentMutation.id",
    "contentMutation.fingerprint",
    "contentMutation.fieldRevisions.notes",
    "contentMutation.fieldRevisions.meetingName",
    "contentMutation.fieldRevisions.summarySentence",
    "contentMutation.fieldRevisions.summaryLabel",
    "canonicalWriter.kind",
    "canonicalWriter.ownerInstanceId",
    "canonicalWriter.executionVersion",
    "canonicalWriter.uploadId",
    "canonicalWriter.instanceId",
    "canonicalWriter.attempt",
    "canonicalWriter.claimId",
    "updateDelivery.revision",
    "updateDelivery.policy.kind",
    "updateDelivery.policy.reason",
    "updateDelivery.progress.kind",
    "updateDeliveryQueue",
    "updateDeliveryDueAt",
    "publicationRepair.kind",
    "publicationRepair.runId",
    "publicationRepair.previewDigest",
    "publicationRepair.receiptKey",
    "publicationRepair.snapshot",
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
  stripeWebhook: receiptProjections,
  guildSubscription: billingProjections,
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
    // Admission presence alone blocks the future-only receipt class, even if malformed.
    if (path === "firstAdmission" || path === "admission") value = true;
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
    compatibleFuture: futureReviewSchema.optional(),
    pausedDesktopDrafts:
      require("./production-paused-draft-binding.cjs").pausedDesktopDraftsSchema.optional(),
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
  const linked = snapshot.records.some((other) => {
    if (other === entry || other.table === "meetingHistory") return false;
    const m = other.metadata;
    const guild = m.guildId ?? m.meetingGuildId ?? m.input?.serverId;
    if (guild !== r.guildId) return false;
    const meeting = m.meetingId ?? m.input?.meetingId;
    if (meeting && r.meetingId && meeting !== r.meetingId) return false;
    if (
      m.channelId_timestamp &&
      m.channelId_timestamp !== r.channelId_timestamp
    )
      return false;
    return !safeCategories.includes(categoryFor(other, snapshot, review));
  });
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
function hasPublicationHistory(r) {
  // Domain completion can follow readback; it cannot establish A acknowledgment.
  return (
    publicationParents.some((field) => r[field] !== undefined) ||
    r.updateDeliveryQueue !== undefined ||
    r.updateDeliveryDueAt !== undefined ||
    (r.contentRevision !== undefined && r.contentRevision !== 0)
  );
}
function historyCategory(entry, snapshot, review) {
  const r = entry.metadata;
  if (hasPublicationHistory(r)) return "uncertain_external_effect";
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
function retainedGuardFields(category) {
  if (category !== "meetingHistory") return projections[category];
  // Leaf projections cannot diagnose malformed parents; final absence must still hold.
  return [
    ...projections.meetingHistory.filter(
      (path) => !publicationParents.includes(path.split(".")[0]),
    ),
    ...publicationParents,
  ];
}
function personalJobCategory(r) {
  if (
    r.status === "complete" &&
    r.completedAt &&
    r.processingOwnerInstanceId === undefined &&
    r.claimExpiresAt === undefined
  )
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
};
function categoryFor(entry, snapshot, review, futureReview) {
  if (entry.table === "guildSubscription")
    return billingCategory(entry, snapshot, futureReview);
  if (entry.table === "meetingHistory")
    return historyCategory(entry, snapshot, review);
  return classifiers[entry.table]?.(entry.metadata) ?? "unknown_metadata";
}
function classifyRetainedWork(
  snapshot,
  reviewedDisposition,
  compatibilityBinding,
  pausedCohort,
) {
  const review = dispositionSchema.safeParse(reviewedDisposition);
  const futureReview = review.success
    ? bindFutureReview(review.data, compatibilityBinding)
    : undefined;
  const records = snapshot.records.map((entry) => ({
    table: entry.table,
    key: entry.key,
    category:
      require("./production-paused-drafts.cjs").pausedCategory(
        pausedCohort,
        entry,
        snapshot,
      ) ??
      categoryFor(
        entry,
        snapshot,
        review.success ? review.data : undefined,
        futureReview,
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
        ...safeCategories,
        "preserved_paused_desktop_draft",
        "installable_paused_desktop_draft",
        "requires_atomic_pause_install",
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
/** Feasibility only: final acceptance still recollects the complete retained inventory. */
function assertInitialPersonalFeasibility(snapshot, pausedCohort) {
  const personal = {
    ...snapshot,
    records: snapshot.records.filter((row) =>
      ["personalJob", "personalSegment"].includes(row.table),
    ),
  };
  if (
    classifyRetainedWork(personal, undefined, undefined, pausedCohort)
      .reopeningBlockers.length
  )
    throw Error("personal_retained_prerequisite");
}
module.exports = {
  readRetainedMetadata,
  classifyRetainedWork,
  projections,
  retainedGuardFields,
  assertInitialPersonalFeasibility,
};
