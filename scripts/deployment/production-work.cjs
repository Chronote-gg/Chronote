"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  validateBinding: validateMaintenanceBinding,
} = require("./maintenance-fence.cjs");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const projections = {
  webhooks: [
    "eventId",
    "state",
    "leaseToken",
    "leaseUntil",
    "receivedAt",
    "expiresAt",
  ],
  payments: ["TransactionID", "transactionID", "status", "paymentDate"],
  leases: [
    "guildId",
    "meetingId",
    "ownerInstanceId",
    "status",
    "leaseExpiresAt",
    "expiresAt",
    "executionVersion",
    "sessionMode",
    "voiceOperationAttemptId",
    "recoveryAttemptId",
    "updatedAt",
    "endedAt",
  ],
  history: [
    "guildId",
    "channelId_timestamp",
    "meetingId",
    "status",
    "ownerInstanceId",
    "executionVersion",
    "ownershipScope",
    "ownerUserId",
    "delivery",
    "updatedAt",
  ],
  controls: [
    "requestId",
    "queueStatus",
    "commandType",
    "targetOwnerInstanceId",
    "claimedByInstanceId",
    "claimId",
    "claimExpiresAt",
    "expiresAt",
    "updatedAt",
  ],
  uploads: [
    "uploadId",
    "ownerUserId",
    "status",
    "mediaKind",
    "uploadOrigin",
    "sourceS3Key",
    "contentType",
    "fileSize",
    "meetingGuildId",
    "meetingId",
    "channelId_timestamp",
    "attempts",
    "processingClaimId",
    "processingOwnerInstanceId",
    "claimExpiresAt",
    "processingStartedAt",
    "completedAt",
    "expiresAt",
    "updatedAt",
    "retryable",
  ],
  segments: [
    "uploadId",
    "segmentKey",
    "ownerUserId",
    "sourceId",
    "sequence",
    "kind",
    "sourceS3Key",
    "contentType",
    "fileSize",
    "checksumSha256",
    "durationMillis",
    "status",
    "updatedAt",
  ],
  billing: [
    "guildId",
    "operationId",
    "attemptId",
    "revision",
    "state",
    "status",
    "tier",
    "subscriptionType",
    "startDate",
    "stripeSyncRevision",
    "reconciled",
    "expiresAt",
    "updatedAt",
    "incidentKey",
    "key",
    "blocking",
    "projection.state",
    "receipts.canceled",
    "receipts.collectionRestored",
    "receipts.collectionToRestore",
    "settlement.status",
    "settlement.settledAt",
    "released.reason",
    "released.verifiedAt",
  ],
};
const keys = {
  webhooks: ["eventId"],
  payments: ["TransactionID"],
  leases: ["guildId"],
  history: ["guildId", "channelId_timestamp"],
  controls: ["requestId"],
  uploads: ["uploadId"],
  segments: ["uploadId", "segmentKey"],
  billing: ["guildId"],
};
const terminalHistory = ["complete", "cancelled", "failed", "interrupted"];
const metadataDigest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nonempty = (value) => typeof value === "string" && value.length > 0;
function validateBinding(binding) {
  validateMaintenanceBinding(binding);
  assert.match(binding.operationId, /^[0-9a-f-]{36}$/i);
  assert.match(binding.sourceSha, /^[0-9a-f]{40}$/i);
  assert.match(binding.legacySha, /^[0-9a-f]{40}$/i);
  assert.match(binding.candidateDigest, /^sha256:[0-9a-f]{64}$/);
  for (const name of Object.keys(projections))
    assert.match(
      binding.tableArns[name],
      /^arn:aws:dynamodb:[a-z0-9-]+:\d{12}:table\/[A-Za-z0-9_.-]+$/,
    );
  assert.equal(
    new Set(Object.values(binding.tableArns)).size,
    Object.keys(projections).length,
  );
  assert.equal(binding.tableArns.leases, binding.activeMeetingTableArn);
  assert.equal(
    binding.tableArns.uploads,
    binding.personalMediaUploadJobTableArn,
  );
  for (const arn of Object.values(binding.tableArns))
    assert.ok(
      arn.startsWith(
        `arn:aws:dynamodb:${binding.region}:${binding.accountId}:table/`,
      ),
    );
}
function rowKey(table, row) {
  assert.ok(
    keys[table].every((key) => nonempty(row[key])),
    "Missing work identity",
  );
  return Object.fromEntries(keys[table].map((key) => [key, row[key]]));
}
function assertScan(snapshot, table) {
  const rows = snapshot.tables[table];
  const scan = snapshot.scans[table];
  assert.ok(
    Array.isArray(rows) && scan?.complete === true,
    "Incomplete work inventory",
  );
  assert.equal(scan.tableArn, snapshot.binding.tableArns[table]);
  assert.ok(scan.pages.length > 0 && scan.pages.length <= 1000);
  let cursor = null;
  let offset = 0;
  const seen = new Set();
  for (const page of scan.pages) {
    assert.deepEqual(page.startKey, cursor, "Missing inventory page");
    assert.ok(Number.isSafeInteger(page.count) && page.count >= 0);
    assert.equal(
      page.digest,
      metadataDigest(rows.slice(offset, offset + page.count)),
    );
    offset += page.count;
    cursor = page.endKey;
    const id = JSON.stringify(cursor);
    assert.ok(!seen.has(id), "Repeated inventory page");
    seen.add(id);
  }
  assert.equal(cursor, null, "Unfinished inventory");
  assert.equal(offset, rows.length);
  const identities = rows.map((row) => JSON.stringify(rowKey(table, row)));
  assert.equal(
    new Set(identities).size,
    rows.length,
    "Duplicate work identity",
  );
}
function acknowledged(snapshot, table, row) {
  return snapshot.settlements?.some(
    (receipt) =>
      receipt.table === table &&
      receipt.rowDigest === metadataDigest(row) &&
      receipt.effects === "acknowledged" &&
      nonempty(receipt.evidenceId),
  );
}
function ownedState(snapshot, owner, expiry) {
  if (!snapshot.owners.includes(owner) || !Number.isFinite(expiry))
    return "blocked";
  return expiry > snapshot.observedAt ? "active" : "blocked";
}
function compatibleUpload(snapshot, compatibility, row) {
  const matches =
    compatibility.uploads?.filter((entry) => entry.uploadId === row.uploadId) ??
    [];
  if (matches.length !== 1) return false;
  const evidence = matches[0];
  const fields = [
    "sourceInput",
    "token",
    "schema",
    "ownership",
    "claimProtocol",
  ];
  return (
    evidence.rowDigest === metadataDigest(row) &&
    fields.every((field) => evidence[field] === "verified") &&
    nonempty(evidence.evidenceId) &&
    Number.isFinite(evidence.validUntil) &&
    evidence.validUntil > snapshot.observedAt
  );
}
function validUploadInput(row) {
  return (
    nonempty(row.sourceS3Key) &&
    nonempty(row.contentType) &&
    ["audio", "video"].includes(row.mediaKind) &&
    Number.isSafeInteger(row.fileSize) &&
    row.fileSize > 0
  );
}
function classifyUpload(snapshot, compatibility, row) {
  if (!nonempty(row.ownerUserId)) return "blocked";
  if (row.status === "processing")
    return ownedState(
      snapshot,
      row.processingOwnerInstanceId,
      row.claimExpiresAt,
    );
  if (["complete", "failed"].includes(row.status))
    return acknowledged(snapshot, "uploads", row) ? "retained" : "blocked";
  if (!["pending_upload", "queued"].includes(row.status)) return "blocked";
  if (
    [
      "processingOwnerInstanceId",
      "processingClaimId",
      "claimExpiresAt",
      "processingStartedAt",
      "meetingId",
    ].some((field) => Object.hasOwn(row, field))
  )
    return "blocked";
  if (!validUploadInput(row)) return "blocked";
  return compatibleUpload(snapshot, compatibility, row)
    ? "portable"
    : "blocked";
}
function classifyHistory(snapshot, row) {
  if (!nonempty(row.meetingId)) return "blocked";
  if (terminalHistory.includes(row.status))
    return acknowledged(snapshot, "history", row) ? "retained" : "blocked";
  const leases = snapshot.tables.leases.filter(
    (lease) =>
      lease.guildId === row.guildId && lease.meetingId === row.meetingId,
  );
  if (leases.length !== 1) return "blocked";
  const lease = leases[0];
  if (row.ownerInstanceId && row.ownerInstanceId !== lease.ownerInstanceId)
    return "blocked";
  return ownedState(snapshot, lease.ownerInstanceId, lease.leaseExpiresAt);
}
function classifyControl(snapshot, row) {
  if (row.queueStatus === "pending") {
    if (row.claimedByInstanceId)
      return ownedState(snapshot, row.claimedByInstanceId, row.claimExpiresAt);
    return "active";
  }
  if (["completed", "failed"].includes(row.queueStatus))
    return acknowledged(snapshot, "controls", row) ? "retained" : "blocked";
  return "blocked";
}
function classifySegment(snapshot, compatibility, row) {
  const parent = snapshot.tables.uploads.find(
    (upload) => upload.uploadId === row.uploadId,
  );
  if (!parent || row.ownerUserId !== parent.ownerUserId) return "blocked";
  if (["processed", "failed"].includes(row.status))
    return acknowledged(snapshot, "segments", row) ? "retained" : "blocked";
  if (!["pending_upload", "uploaded", "submitted"].includes(row.status))
    return "blocked";
  if (classifyUpload(snapshot, compatibility, parent) !== "portable")
    return "blocked";
  const evidence = compatibility.uploads.find(
    (entry) => entry.uploadId === row.uploadId,
  );
  return evidence.segmentDigests?.includes(metadataDigest(row))
    ? "portable"
    : "blocked";
}
// Metadata predicates follow the durable states in types/{purchase,renewal,billingChange,renewalRecovery}.ts.
function billingTerminal(row, kind) {
  switch (kind) {
    case "CHANGE_OP":
      return (
        ["succeeded", "canceled"].includes(row.state) && row.reconciled === true
      );
    case "RENEWAL_OP":
      return ["succeeded", "rejected"].includes(row.state);
    case "PURCHASE":
      return (
        ["completed", "expired"].includes(row.state) &&
        !row.incidentKey &&
        nonempty(row.attemptId)
      );
    case "RENEWAL_RECOVERY":
      return recoveryTerminal(row);
    case "OFFER":
      return offerTerminal(row);
    default:
      return false;
  }
}
function recoveryTerminal(row) {
  if (row.state === "ended") return true;
  if (row.state === "paid") return row.projection?.state === "complete";
  const receipts = row.receipts;
  if (
    !receipts?.collectionRestored ||
    !Array.isArray(receipts.collectionToRestore)
  )
    return false;
  if (row.state === "canceled") return receipts.canceled === true;
  return row.state === "superseded" && row.projection?.state === "complete";
}
function offerTerminal(row) {
  if (row.state === "used")
    return (
      row.settlement?.status === "paid" &&
      Number.isFinite(row.settlement.settledAt)
    );
  return (
    row.state === "unused" &&
    [
      "checkout_expired",
      "initial_invoice_voided",
      "change_canceled",
      "schedule_canceled",
    ].includes(row.released?.reason) &&
    Number.isFinite(row.released.verifiedAt)
  );
}
function billingPointer(snapshot, row, kind, guild) {
  const recovery = kind === "RENEWAL_RECOVERY_CURRENT";
  const targetKey = recovery
    ? row.key
    : `${kind.replace("_CONTROL", "_OP")}#${guild}#${row.operationId}`;
  const target = snapshot.tables.billing.find(
    (entry) => entry.guildId === targetKey,
  );
  if (!target || !nonempty(target.revision)) return "blocked";
  if (
    recovery &&
    (row.blocking !== false ||
      !targetKey.startsWith(`RENEWAL_RECOVERY#${guild}#`))
  )
    return "blocked";
  if (kind !== "CHANGE_CONTROL" && row.revision !== target.revision)
    return "blocked";
  return classifyBilling(snapshot, target, false);
}
function classifyBilling(snapshot, row, allowPointer = true) {
  if (/^\d{17,20}$/.test(row.guildId)) {
    const staticFields = ["status", "tier", "subscriptionType", "startDate"];
    return staticFields.every((field) => nonempty(row[field])) &&
      !Object.hasOwn(row, "state")
      ? "retained"
      : "blocked";
  }
  const [kind, guild, id] = row.guildId.split("#");
  if (
    ["CHANGE_CONTROL", "RENEWAL_CONTROL", "RENEWAL_RECOVERY_CURRENT"].includes(
      kind,
    )
  )
    return allowPointer && /^\d{17,20}$/.test(guild)
      ? billingPointer(snapshot, row, kind, guild)
      : "blocked";
  if (!billingIdentity(row, kind, guild, id)) return "blocked";
  return billingTerminal(row, kind) && acknowledged(snapshot, "billing", row)
    ? "retained"
    : "blocked";
}
function billingIdentity(row, kind, guild, id) {
  if (!nonempty(row.revision)) return false;
  if (kind === "OFFER")
    return (
      /^(live|test)$/.test(guild) &&
      /^\d{17,20}$/.test(id) &&
      row.guildId.split("#").length === 4
    );
  if (!/^\d{17,20}$/.test(guild)) return false;
  if (["CHANGE_OP", "RENEWAL_OP"].includes(kind))
    return (
      nonempty(id) &&
      id === row.operationId &&
      row.guildId.split("#").length === 3
    );
  if (kind === "PURCHASE") return row.guildId.split("#").length === 2;
  return (
    kind === "RENEWAL_RECOVERY" &&
    nonempty(id) &&
    /^\d+$/.test(row.guildId.split("#")[3])
  );
}
function classifyRow(snapshot, compatibility, table, row) {
  switch (table) {
    case "webhooks":
      return row.state === "completed" && acknowledged(snapshot, table, row)
        ? "retained"
        : "blocked";
    case "payments":
      return row.TransactionID === row.transactionID &&
        row.status === "paid" &&
        nonempty(row.paymentDate) &&
        Number.isFinite(Date.parse(row.paymentDate))
        ? "retained"
        : "blocked";
    case "leases":
      return ownedState(snapshot, row.ownerInstanceId, row.leaseExpiresAt);
    case "history":
      return classifyHistory(snapshot, row);
    case "uploads":
      return classifyUpload(snapshot, compatibility, row);
    case "controls":
      return classifyControl(snapshot, row);
    case "segments":
      return classifySegment(snapshot, compatibility, row);
    case "billing":
      return classifyBilling(snapshot, row);
    default:
      return "blocked";
  }
}
function classifyProductionWork(snapshot, compatibility) {
  const result = {
    active: [],
    portable: [],
    blocked: [],
    counts: { active: 0, portable: 0, blocked: 0, retained: 0 },
  };
  try {
    validateBinding(snapshot.binding);
    assert.deepEqual(compatibility.binding, snapshot.binding);
    assert.ok(Number.isFinite(snapshot.observedAt));
    assert.ok(
      Array.isArray(snapshot.owners) && snapshot.owners.every(nonempty),
    );
    for (const table of Object.keys(projections)) assertScan(snapshot, table);
  } catch {
    result.blocked.push({ reason: "incomplete_or_unbound_inventory" });
    result.counts.blocked = 1;
    return result;
  }
  for (const table of Object.keys(projections)) {
    for (const row of snapshot.tables[table]) {
      const category = classifyRow(snapshot, compatibility, table, row);
      result.counts[category]++;
      if (category !== "retained")
        result[category].push({
          table,
          key: rowKey(table, row),
          reason: category,
        });
    }
  }
  return result;
}
function assertProductionDrain(proof, binding) {
  validateBinding(binding);
  const { snapshot, compatibility, barrier, now } = proof;
  assert.deepEqual(snapshot.binding, binding);
  assert.deepEqual(barrier.binding, binding);
  assert.deepEqual(barrier.owners, snapshot.owners);
  assert.ok(nonempty(barrier.evidenceId));
  assert.ok(
    [barrier.fencedAt, barrier.checkedAt, barrier.validUntil].every(
      Number.isFinite,
    ),
    "Invalid barrier time",
  );
  assert.equal(barrier.admission, "closed");
  assert.equal(barrier.effects, "settled");
  assert.ok(nonempty(barrier.revisionBefore));
  assert.equal(
    barrier.revisionBefore,
    barrier.revisionAfter,
    "Concurrent work claim",
  );
  assert.ok(
    Number.isFinite(now) &&
      barrier.fencedAt <= snapshot.observedAt &&
      snapshot.observedAt <= barrier.checkedAt &&
      barrier.checkedAt <= now &&
      now < barrier.validUntil,
    "Stale drain barrier",
  );
  const result = classifyProductionWork(snapshot, compatibility);
  assert.equal(result.active.length, 0, "Active production work");
  assert.equal(result.blocked.length, 0, "Uncertain production work");
  for (const entry of compatibility.uploads ?? [])
    assert.ok(entry.validUntil > now, "Expired compatibility evidence");
  return result;
}
async function scanTable(aws, table, options) {
  const fields = projections[table];
  const names = {};
  const paths = fields.map((field, index) =>
    field
      .split(".")
      .map((part, depth) => {
        const key = `#f${index}_${depth}`;
        names[key] = part;
        return key;
      })
      .join("."),
  );
  const rows = [];
  const pages = [];
  let cursor = null;
  const seen = new Set();
  do {
    assert.ok(
      pages.length < options.maxPages,
      "Work inventory page bound exceeded",
    );
    const page = await aws("dynamodb", "scan", {
      TableName: options.binding.tableArns[table],
      ConsistentRead: true,
      Limit: options.pageSize,
      ProjectionExpression: paths.join(", "),
      ExpressionAttributeNames: names,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    });
    assert.ok(Array.isArray(page.Items), "Missing inventory items");
    const items = page.Items.map((item) => unmarshall(item));
    assert.ok(
      items.every((item) =>
        Object.keys(item).every((key) =>
          fields.some((field) => field.split(".")[0] === key),
        ),
      ),
      "Unexpected inventory metadata",
    );
    const next =
      page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length
        ? page.LastEvaluatedKey
        : null;
    pages.push({
      startKey: cursor,
      endKey: next,
      count: items.length,
      digest: metadataDigest(items),
    });
    rows.push(...items);
    assert.ok(
      rows.length <= options.maxRows,
      "Work inventory row bound exceeded",
    );
    assert.ok(!seen.has(JSON.stringify(next)), "Repeated inventory cursor");
    seen.add(JSON.stringify(next));
    cursor = next;
  } while (cursor);
  return {
    rows,
    receipt: {
      tableArn: options.binding.tableArns[table],
      complete: true,
      pages,
    },
  };
}
async function scanProductionWork(aws, options) {
  validateBinding(options.binding);
  const limits = { maxPages: 1000, maxRows: 100000, pageSize: 100, ...options };
  for (const key of ["maxPages", "maxRows", "pageSize"])
    assert.ok(Number.isSafeInteger(limits[key]) && limits[key] > 0);
  assert.ok(
    limits.maxPages <= 1000 &&
      limits.maxRows <= 100000 &&
      limits.pageSize <= 1000,
  );
  const snapshot = {
    binding: options.binding,
    observedAt: options.observedAt,
    owners: options.owners,
    tables: {},
    scans: {},
    settlements: [],
  };
  for (const table of Object.keys(projections)) {
    const { rows, receipt } = await scanTable(aws, table, limits);
    snapshot.tables[table] = rows;
    snapshot.scans[table] = receipt;
  }
  return snapshot;
}
module.exports = {
  classifyProductionWork,
  assertProductionDrain,
  scanProductionWork,
  metadataDigest,
};
