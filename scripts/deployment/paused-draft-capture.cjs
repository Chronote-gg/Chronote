"use strict";
const assert = require("node:assert/strict");
const { unmarshall, marshall } = require("@aws-sdk/util-dynamodb");
const { nativeTransport } = require("./collector-native.cjs");
const { awsCaller, manifestHash } = require("./sandbox-manifest.cjs");
const { createPreparationCapture } = require("./private-capture.cjs");
const {
  identitiesSchema,
  parentSchema,
  segmentSchema,
  markerSchema,
  parentFields,
  segmentFields,
  preparationIdentity,
  captureBinding,
  validatePausedBinding,
  rowDigest,
  objectSchema,
} = require("./paused-draft-contract.cjs");
const acquired = new WeakSet();
function trustEvidence(value) {
  function freeze(object) {
    if (object && typeof object === "object") {
      Object.values(object).forEach(freeze);
      Object.freeze(object);
    }
  }
  freeze(value);
  acquired.add(value);
  return value;
}
function matchesSnapshot(evidence, snapshot) {
  if (!acquired.has(evidence) || evidence.validUntil <= snapshot.observedAt)
    return false;
  if (manifestHash(evidence.binding) !== manifestHash(snapshot.binding))
    return false;
  for (const [table, field] of [
    ["uploads", "parents"],
    ["segments", "segments"],
  ]) {
    const rows = snapshot.tables[table].filter((row) =>
      evidence.identities.some((id) => id.uploadId === row.uploadId),
    );
    const actual = rows.map(rowDigest).sort();
    const expected = evidence[field].map((row) => row.digest).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  return true;
}
function classifyPausedDraft(snapshot, compatibility, table, row) {
  const evidence = compatibility.pausedDrafts;
  if (!evidence) return undefined;
  const identities = identitiesSchema.safeParse(evidence.identities);
  if (!identities.success) return "blocked";
  if (!identities.data.some((identity) => identity.uploadId === row.uploadId))
    return undefined;
  if (!matchesSnapshot(evidence, snapshot)) return "blocked";
  const field = table === "uploads" ? "parents" : "segments";
  return evidence[field].some(
    (entry) =>
      entry.uploadId === row.uploadId && entry.digest === rowDigest(row),
  )
    ? "retained"
    : "blocked";
}
function parseManifest(options) {
  const module =
    options.manifest.kind === "rehearsal-introduction"
      ? "./rehearsal-manifest.cjs"
      : "./production-manifest.cjs";
  const parser =
    options.manifest.kind === "rehearsal-introduction"
      ? "parseRehearsalManifest"
      : "parseProductionManifest";
  return require(module)[parser](options.manifest, options.expectedSha256);
}
function storeFor(m, options) {
  assert.equal(options.storageBinding.accountId, m.binding.accountId);
  assert.equal(options.storageBinding.region, m.binding.region);
  return createPreparationCapture({
    preparation: preparationIdentity(m),
    binding: options.storageBinding,
    client: options.s3,
    now: options.now,
  });
}
function projection(fields) {
  return {
    ProjectionExpression: fields.map((_, index) => `#f${index}`).join(", "),
    ExpressionAttributeNames: Object.fromEntries(
      fields.map((field, index) => [`#f${index}`, field]),
    ),
  };
}
async function readSegments(aws, m, identity) {
  const rows = [],
    seen = new Set();
  let cursor;
  for (let page = 0; page < m.maxPages; page++) {
    const result = await aws("dynamodb", "query", {
      TableName: m.binding.tableArns.segments,
      ConsistentRead: true,
      Limit: m.pageSize,
      ...projection(segmentFields),
      KeyConditionExpression: "#uploadId = :uploadId",
      ExpressionAttributeNames: {
        ...projection(segmentFields).ExpressionAttributeNames,
        "#uploadId": "uploadId",
      },
      ExpressionAttributeValues: marshall({ ":uploadId": identity.uploadId }),
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    });
    assert.ok(Array.isArray(result.Items));
    rows.push(
      ...result.Items.map((item) => segmentSchema.parse(unmarshall(item))),
    );
    assert.ok(rows.length <= m.maxRows);
    const next = result.LastEvaluatedKey;
    if (!next || Object.keys(next).length === 0) return rows;
    const key = unmarshall(next);
    assert.deepEqual(Object.keys(key).sort(), ["segmentKey", "uploadId"]);
    assert.equal(key.uploadId, identity.uploadId);
    assert.ok(typeof key.segmentKey === "string" && key.segmentKey.length > 0);
    const digest = rowDigest(key);
    assert.ok(!seen.has(digest));
    seen.add(digest);
    cursor = next;
  }
  throw new Error("UNKNOWN: paused draft page bound");
}
function validateRows(identity, parent, segments) {
  assert.equal(parent.uploadId, identity.uploadId);
  assert.equal(parent.ownerUserId, identity.ownerUserId);
  const sourceIds = parent.sourceManifest.map((source) => source.sourceId);
  assert.equal(new Set(sourceIds).size, sourceIds.length);
  const prefix = `personal-media-uploads/${identity.ownerUserId}/${identity.uploadId}/`;
  assert.ok(
    parent.sourceS3Key === prefix + "segments/" ||
      [...parent.sourceManifest, ...segments].some(
        (row) => row.sourceS3Key === parent.sourceS3Key,
      ),
  );
  assert.equal(
    new Set(segments.map((row) => row.segmentKey)).size,
    segments.length,
  );
  for (const row of segments) {
    assert.equal(row.uploadId, identity.uploadId);
    assert.equal(row.ownerUserId, identity.ownerUserId);
    assert.equal(
      row.segmentKey,
      `${row.sourceId}#${String(row.sequence).padStart(6, "0")}`,
    );
    const source = parent.sourceManifest.find(
      (source) => source.sourceId === row.sourceId,
    );
    assert.ok(source);
    assert.equal(row.kind, source.kind);
    assert.equal(row.label, source.label);
    assert.ok(row.sourceS3Key.startsWith(prefix));
  }
  for (const source of parent.sourceManifest)
    if (source.sourceS3Key) assert.ok(source.sourceS3Key.startsWith(prefix));
}
async function readDrafts(aws, m, identities) {
  const drafts = [];
  let metadataRows = 0;
  for (const identity of identities) {
    const result = await aws("dynamodb", "get-item", {
      TableName: m.binding.tableArns.uploads,
      ConsistentRead: true,
      Key: marshall({ uploadId: identity.uploadId }),
      ...projection(parentFields),
    });
    assert.ok(result.Item);
    const parent = parentSchema.parse(unmarshall(result.Item));
    metadataRows += 1 + parent.sourceManifest.length;
    assert.ok(metadataRows <= m.maxRows);
    const segments = await readSegments(aws, m, identity);
    metadataRows += segments.length;
    assert.ok(metadataRows <= m.maxRows);
    validateRows(identity, parent, segments);
    drafts.push({
      parent,
      segments: segments.sort((a, b) =>
        a.segmentKey.localeCompare(b.segmentKey),
      ),
    });
  }
  return drafts;
}
function objectInputs(drafts) {
  const objects = [];
  for (const { parent, segments } of drafts) {
    for (const row of [
      ...parent.sourceManifest.filter((source) => source.sourceS3Key),
      ...segments,
    ]) {
      assert.ok(Number.isSafeInteger(row.fileSize) && row.fileSize > 0);
      assert.ok(
        typeof row.contentType === "string" && row.contentType.length > 0,
      );
      objects.push({
        uploadId: parent.uploadId,
        ownerUserId: parent.ownerUserId,
        key: row.sourceS3Key,
        size: row.fileSize,
        contentType: row.contentType,
        checksumSha256: row.checksumSha256 ?? null,
      });
    }
  }
  assert.equal(
    new Set(objects.map((object) => object.key)).size,
    objects.length,
  );
  return objects;
}
async function readObjects(aws, m, inputs) {
  const objects = [];
  for (const object of inputs) {
    const head = await aws("s3", "head-object", {
      Bucket: m.bucket,
      ExpectedBucketOwner: m.binding.accountId,
      Key: object.key,
      ChecksumMode: "ENABLED",
      ...(object.versionId ? { VersionId: object.versionId } : {}),
    });
    assert.ok(
      typeof head.VersionId === "string" &&
        head.VersionId.length > 0 &&
        head.VersionId !== "null" &&
        head.VersionId.length <= 1024,
    );
    if (object.versionId) assert.equal(head.VersionId, object.versionId);
    assert.equal(head.ContentLength, object.size);
    assert.equal(head.ContentType, object.contentType);
    if (object.checksumSha256)
      assert.equal(
        head.ChecksumSHA256,
        Buffer.from(object.checksumSha256, "hex").toString("base64"),
      );
    objects.push(
      objectSchema.parse({
        ...object,
        versionId: head.VersionId,
        checksumSHA256: head.ChecksumSHA256 ?? null,
      }),
    );
  }
  return objects;
}
function bounded(m, options) {
  const now = options.now ?? (() => Date.now() / 1000);
  return nativeTransport(
    options.aws ?? awsCaller(m.binding.region),
    Math.min(options.validUntil ?? m.validUntil, m.validUntil),
    () => now() * 1000,
  );
}
async function preparePausedDrafts(options) {
  try {
    const m = parseManifest(options);
    assert.ok(!m.pausedDrafts);
    const identities = identitiesSchema.parse(options.identities);
    const store = storeFor(m, options),
      aws = bounded(m, options);
    const drafts = await readDrafts(aws, m, identities);
    const objects = await readObjects(aws, m, objectInputs(drafts));
    const capture = await store.capture({
      kind: "paused-desktop-draft-metadata-v1",
      binding: captureBinding(m),
      identities,
      drafts,
      objects,
    });
    return { identities, capture };
  } catch {
    throw new Error(
      "UNKNOWN: paused draft preparation unavailable; do not retry uncertain capture",
    );
  }
}
function project(row, fields) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => fields.includes(key)),
  );
}
async function readMarkers(aws, m, manifestSha256, now) {
  const markers = [];
  for (const identity of m.pausedDrafts.identities) {
    const result = await aws("dynamodb", "get-item", {
      TableName: m.controlTableArn,
      ConsistentRead: true,
      Key: marshall({ pk: `UPLOAD#${identity.uploadId}`, sk: "PAUSED_DRAFT" }),
    });
    assert.ok(result.Item);
    const marker = markerSchema.parse(unmarshall(result.Item));
    assert.equal(marker.uploadId, identity.uploadId);
    assert.equal(marker.ownerUserId, identity.ownerUserId);
    assert.equal(marker.operationId, m.binding.operationId);
    assert.equal(marker.manifestSha256, manifestSha256);
    assert.equal(marker.preservedCaptureSha256, m.pausedDrafts.capture.sha256);
    assert.ok(marker.createdAt <= now());
    markers.push(marker);
  }
  return markers;
}
async function collectPausedDrafts(options) {
  if (!options.m.pausedDrafts) return undefined;
  try {
    const m = parseManifest({ ...options, manifest: options.m });
    validatePausedBinding(m);
    const now = options.now ?? (() => Date.now() / 1000),
      aws = bounded(m, options);
    const original = await storeFor(m, options).readCapture(
      m.pausedDrafts.capture,
    );
    assert.deepEqual(Object.keys(original).sort(), [
      "binding",
      "drafts",
      "identities",
      "kind",
      "objects",
    ]);
    assert.equal(original.kind, "paused-desktop-draft-metadata-v1");
    assert.deepEqual(original.binding, captureBinding(m));
    assert.deepEqual(original.identities, m.pausedDrafts.identities);
    const drafts = await readDrafts(aws, m, m.pausedDrafts.identities);
    assert.deepEqual(drafts, original.drafts);
    const preservedObjects = original.objects.map((object) =>
      objectSchema.parse(object),
    );
    assert.deepEqual(
      preservedObjects.map((object) =>
        project(object, [
          "uploadId",
          "ownerUserId",
          "key",
          "size",
          "contentType",
          "checksumSha256",
        ]),
      ),
      objectInputs(drafts),
    );
    const objects = await readObjects(aws, m, preservedObjects);
    assert.deepEqual(objects, preservedObjects);
    const markers = await readMarkers(aws, m, options.expectedSha256, now);
    const { projections } = require("./production-work.cjs");
    const entries = (rows, fields) =>
      rows.map((row) => ({
        uploadId: row.uploadId,
        digest: rowDigest(project(row, fields)),
      }));
    const evidence = trustEvidence({
      binding: m.binding,
      identities: m.pausedDrafts.identities,
      capture: m.pausedDrafts.capture,
      manifestSha256: options.expectedSha256,
      markers,
      parents: entries(
        drafts.map((d) => d.parent),
        projections.uploads,
      ),
      segments: entries(
        drafts.flatMap((d) => d.segments),
        projections.segments,
      ),
      validUntil: Math.min(options.validUntil, m.validUntil),
      limitations: [
        "audio_bytes_unproved",
        "future_retention_unproved",
        "runtime_access_unproved",
        "writer_quiescence_unproved",
        "effects_settlement_unproved",
      ],
    });
    assert.ok(
      Number.isFinite(evidence.validUntil) && now() < evidence.validUntil,
    );
    for (const identity of evidence.identities) {
      const row = options.snapshot.tables.uploads.find(
        (row) => row.uploadId === identity.uploadId,
      );
      assert.ok(
        row &&
          classifyPausedDraft(
            options.snapshot,
            { pausedDrafts: evidence },
            "uploads",
            row,
          ) === "retained",
      );
    }
    return evidence;
  } catch {
    throw new Error("UNKNOWN: paused draft native binding unavailable");
  }
}
module.exports = {
  preparePausedDrafts,
  collectPausedDrafts,
  classifyPausedDraft,
};
