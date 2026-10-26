"use strict";
const assert = require("node:assert/strict");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { bindingHash } = require("./continue-sandbox.cjs");
const FIELDS = {
  ActiveMeetingTable: [
    "guildId",
    "meetingId",
    "ownerInstanceId",
    "executionVersion",
    "leaseExpiresAt",
    "sessionMode",
    "recoveryAttemptId",
  ],
  MeetingHistoryTable: [
    "guildId",
    "channelId_timestamp",
    "meetingId",
    "ownerInstanceId",
    "executionVersion",
    "status",
    "checkpoint.revision",
    "capture.kind",
    "recovery.disposition",
    "recovery.stage",
    "recovery.attempt",
    "delivery.notes.outcome",
    "delivery.summary.outcome",
  ],
  MeetingControlCommandTable: [
    "requestId",
    "targetOwnerInstanceId",
    "claimedByInstanceId",
    "claimId",
    "queueStatus",
    "claimExpiresAt",
    "expiresAt",
  ],
  PersonalMediaUploadJobTable: [
    "uploadId",
    "processingOwnerInstanceId",
    "processingClaimId",
    "attempts",
    "claimExpiresAt",
    "status",
  ],
  DeploymentControlTable: [
    "pk",
    "sk",
    "ownerInstanceId",
    "meetingId",
    "attemptId",
    "executionVersion",
    "sessionMode",
    "state",
  ],
};
function metadataRow(raw, fields) {
  const row = {};
  for (const path of fields) {
    const parts = path.split(".");
    const value = parts.reduce((node, part) => node?.[part], raw);
    if (value === undefined) continue;
    assert.ok(
      ["string", "number", "boolean"].includes(typeof value),
      "Malformed source metadata",
    );
    assert.ok(
      JSON.stringify(value).length <= 1024,
      "Oversized source metadata",
    );
    let node = row;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = value;
  }
  return row;
}
async function scanOwned({ aws, tablePrefix, source }, suffix, fields) {
  const rows = [];
  let ExclusiveStartKey;
  for (let page = 0; page < 100; page++) {
    const names = {};
    const projection = fields
      .map((path) =>
        path
          .split(".")
          .map((part) => {
            names["#" + part] = part;
            return "#" + part;
          })
          .join("."),
      )
      .join(",");
    const response = await aws("dynamodb", "scan", {
      TableName: tablePrefix + suffix,
      ConsistentRead: true,
      Limit: 100,
      ProjectionExpression: projection,
      ExpressionAttributeNames: names,
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    });
    for (const item of response.Items ?? []) {
      const raw = unmarshall(item);
      const row = metadataRow(raw, fields);
      if (
        [
          row.ownerInstanceId,
          row.targetOwnerInstanceId,
          row.claimedByInstanceId,
          row.processingOwnerInstanceId,
        ].includes(source.instanceId)
      )
        rows.push(row);
    }
    assert.ok(
      rows.length <= 100,
      "Source metadata exceeds reviewed receipt bound",
    );
    ExclusiveStartKey = response.LastEvaluatedKey;
    if (!ExclusiveStartKey) break;
  }
  assert.ok(!ExclusiveStartKey, "Source metadata pagination incomplete");
  return rows;
}
async function inspectObligations({
  aws,
  tablePrefix,
  source,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const records = {};
  for (const [suffix, fields] of Object.entries(FIELDS))
    records[suffix] = await scanOwned(
      { aws, tablePrefix, source },
      suffix,
      fields,
    );
  assert.ok(
    JSON.stringify(records).length < 200000,
    "Source metadata receipt exceeds safe size",
  );
  // No set of these scans reconstructs the stopped owner's volatile effect ledger.
  return {
    records,
    collectedAt: now(),
    sha256: bindingHash(records),
    counts: Object.fromEntries(
      Object.entries(records).map(([name, rows]) => [name, rows.length]),
    ),
  };
}
module.exports = { inspectObligations };
