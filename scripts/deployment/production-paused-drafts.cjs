"use strict";
const { z } = require("zod");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { canonicalHash } = require("./production-manifest.cjs");
const contract = require("./paused-draft-contract.cjs");
const tokens = new WeakMap();
const shared = require("./production-paused-contract.cjs");
const { parentSchema, segmentSchema, objectSchema } = shared;
const refuse = () => {
  throw Error("paused_draft_prerequisite");
};
const clone = (value) => structuredClone(value);
function issue(value) {
  const token = Object.freeze({});
  const { binding, settingsToken, ...evidence } = value;
  tokens.set(token, { binding, settingsToken, ...clone(evidence) });
  return token;
}
function readToken(token, phases) {
  const value = tokens.get(token),
    now = Math.floor(Date.now() / 1000);
  if (
    !value ||
    (phases && !phases.includes(value.phase)) ||
    now < value.manifest.validFrom ||
    now >= value.validUntil
  )
    refuse();
  const checked =
    require("./production-paused-draft-binding.cjs").readDraftBinding(
      value.binding,
    );
  if (
    checked.manifestHash !== value.manifestHash ||
    checked.purpose !== value.purpose ||
    checked.actor !== value.actor
  )
    refuse();
  const { binding, settingsToken, ...evidence } = value;
  return { binding, settingsToken, ...clone(evidence) };
}
function bindOriginalPausedDisposition(
  binding,
  evidence,
  authenticatedPreparation,
) {
  const checked =
    require("./production-paused-draft-binding.cjs").readDraftBinding(binding);
  const proof =
    require("./production-paused-draft-binding.cjs").readAuthenticatedPausedPreparation(
      authenticatedPreparation,
    );
  const declaration = shared.declarationSchema.parse(
    evidence.retainedDisposition?.pausedDesktopDrafts,
  );
  if (
    proof.manifestHash !== checked.manifestHash ||
    proof.actor !== declaration.preparation.actorId ||
    canonicalHash(proof.declaration) !== canonicalHash(declaration)
  )
    refuse();
  const capture = shared.captureSchema.parse(proof.capture);
  if (
    canonicalHash(declaration.scope) !==
      canonicalHash(shared.scopeFor(checked.manifest)) ||
    canonicalHash(capture.scope) !== canonicalHash(declaration.scope) ||
    canonicalHash(capture.cohort) !== canonicalHash(declaration.cohort)
  )
    refuse();
  return issue({
    phase: "bound",
    binding,
    ...checked,
    identities: declaration.cohort,
    capture,
    declaration,
    request: proof.request,
    validUntil: Math.min(proof.validUntil, checked.manifest.validUntil),
  });
}
function readPausedReaderScope(token) {
  const value = readToken(token);
  const { binding, settingsToken, ...view } = value;
  void binding;
  void settingsToken;
  return {
    ...view,
    objects: shared.captureSchema.parse(value.capture).objects,
  };
}
function assertNextCursor(cursor, id, kind, cursors) {
  const key = unmarshall(cursor),
    hash = canonicalHash(key);
  if (
    !Object.keys(key).length ||
    key.uploadId !== id.uploadId ||
    cursors.has(hash)
  )
    refuse();
  const expected =
    kind === "parent" ? ["uploadId"] : ["segmentKey", "uploadId"];
  if (Object.keys(key).sort().join(",") !== expected.join(",")) refuse();
  if (kind === "segments" && !key.segmentKey) refuse();
  cursors.add(hash);
}
function appendPageItems(rows, seen, items, schema, kind, id) {
  for (const item of items) {
    const row = schema.parse(unmarshall(item));
    if (row.uploadId !== id.uploadId || row.ownerUserId !== id.ownerUserId)
      refuse();
    const key = kind === "parent" ? row.uploadId : row.segmentKey;
    if (seen.has(key)) refuse();
    seen.add(key);
    rows.push(row);
  }
}
async function pages(token, read, kind, id, schema) {
  const rows = [],
    seen = new Set(),
    cursors = new Set();
  let cursor;
  let pageCount = 0;
  do {
    const current = readToken(token);
    if (++pageCount > (current.request?.maxPages ?? 100)) refuse();
    const page = await read(token, {
      kind,
      uploadId: id.uploadId,
      ...(cursor ? { cursor } : {}),
    });
    readToken(token);
    if (!Array.isArray(page?.Items)) refuse();
    appendPageItems(rows, seen, page.Items, schema, kind, id);
    const expectedCount =
      kind === "parent"
        ? 1
        : current.capture.segments.filter((row) => row.uploadId === id.uploadId)
            .length;
    if (rows.length > expectedCount) refuse();
    cursor = page.LastEvaluatedKey;
    if (cursor) assertNextCursor(cursor, id, kind, cursors);
  } while (cursor);
  return rows;
}
function appendObject(objects, parent, source) {
  if (source.sourceS3Key === undefined) {
    if (source.fileSize !== undefined) refuse();
    return;
  }
  if (!(source.fileSize > 0) || !source.contentType) refuse();
  const object = {
    uploadId: parent.uploadId,
    ownerUserId: parent.ownerUserId,
    key: source.sourceS3Key,
    size: source.fileSize,
    contentType: source.contentType,
  };
  const existing = objects.find((row) => row.key === object.key);
  if (existing && canonicalHash(existing) !== canonicalHash(object)) refuse();
  if (!existing) objects.push(object);
}
function objectInputs(parents, segments) {
  const objects = [];
  for (const parent of parents) {
    const sources = [
      ...parent.sourceManifest,
      ...segments.filter((row) => row.uploadId === parent.uploadId),
    ];
    for (const source of sources) appendObject(objects, parent, source);
  }
  if (
    parents.some(
      (parent) =>
        !objects.some((object) => object.uploadId === parent.uploadId),
    )
  )
    refuse();
  return objects;
}
async function collectDraftRows(bound, readers, value) {
  const parents = [],
    segments = [];
  for (const id of value.identities) {
    const rows = await pages(
      bound,
      readers.pausedDraftMetadata,
      "parent",
      id,
      parentSchema,
    );
    if (
      rows.length !== 1 ||
      rows[0].sourceManifest.length !== id.sourceCount ||
      new Set(rows[0].sourceManifest.map((source) => source.sourceId)).size !==
        id.sourceCount
    )
      refuse();
    parents.push(rows[0]);
    const parts = await pages(
      bound,
      readers.pausedDraftMetadata,
      "segments",
      id,
      segmentSchema,
    );
    for (const segment of parts)
      if (
        !rows[0].sourceManifest.some(
          (source) =>
            source.sourceId === segment.sourceId &&
            source.kind === segment.kind,
        )
      )
        refuse();
    const parent = rows[0];
    if (
      parent.segmentCount !== parts.length ||
      parent.uploadedSegmentCount !==
        parts.filter((part) => ["uploaded", "submitted"].includes(part.status))
          .length
    )
      refuse();
    segments.push(...parts);
  }
  if (
    canonicalHash(parents) !== canonicalHash(value.capture.parents) ||
    canonicalHash(
      segments
        .slice()
        .sort((a, b) =>
          `${a.uploadId}/${a.segmentKey}`.localeCompare(
            `${b.uploadId}/${b.segmentKey}`,
          ),
        ),
    ) !==
      canonicalHash(
        value.capture.segments
          .slice()
          .sort((a, b) =>
            `${a.uploadId}/${a.segmentKey}`.localeCompare(
              `${b.uploadId}/${b.segmentKey}`,
            ),
          ),
      )
  )
    refuse();
  return { parents, segments };
}
function assertObjectEncryption(expected, actual) {
  if (
    expected.encryption &&
    (actual.ServerSideEncryption !== expected.encryption.serverSideEncryption ||
      actual.SSEKMSKeyId !== expected.encryption.sseKmsKeyId ||
      actual.BucketKeyEnabled !== expected.encryption.bucketKeyEnabled)
  )
    refuse();
}
function assertObjectMetadata(expected, actual) {
  if (
    actual.DeleteMarker ||
    actual.VersionId !== expected.versionId ||
    actual.ContentLength !== expected.size ||
    actual.ContentType !== expected.contentType
  )
    refuse();
  if ((actual.ChecksumType ?? "unavailable") !== expected.checksumType)
    refuse();
  assertObjectEncryption(expected, actual);
  const required = Object.fromEntries(
    Object.entries(expected.requiredChecksums ?? {}).map(
      ([field, predicate]) => [field, predicate.value],
    ),
  );
  for (const [field, value] of Object.entries({
    ...expected.checksums,
    ...required,
  }))
    if (actual[field] !== value) refuse();
}
async function collectDraftObjects(bound, readers, value, parents, segments) {
  const objects = z.array(objectSchema).parse(value.capture.objects),
    inputs = objectInputs(parents, segments);
  if (
    objects.length !== inputs.length ||
    new Set(objects.map((o) => o.key)).size !== objects.length
  )
    refuse();
  for (const input of inputs) {
    const expected = objects.find((o) => o.key === input.key);
    if (
      !expected ||
      Object.entries(input).some(([key, v]) => expected[key] !== v)
    )
      refuse();
    const actual = await readers.pausedDraftMetadata(bound, {
      kind: "object",
      key: expected.key,
      versionId: expected.versionId,
    });
    readToken(bound);
    assertObjectMetadata(expected, actual);
  }
  return objects;
}
async function assertDraftStorage(bound, readers) {
  for (const table of ["personalJob", "personalSegment"]) {
    const ttl = await readers.pausedDraftMetadata(bound, {
      kind: "tableTtl",
      table,
    });
    if (ttl.TimeToLiveDescription?.TimeToLiveStatus !== "DISABLED") refuse();
  }
  const versioning = await readers.pausedDraftMetadata(bound, {
    kind: "bucketVersioning",
  });
  if (versioning.Status !== "Enabled") refuse();
  const lifecycle = await readers.pausedDraftMetadata(bound, {
    kind: "bucketLifecycle",
  });
  if (
    !Array.isArray(lifecycle.Rules) ||
    lifecycle.Rules.some(
      (rule) =>
        rule.Status !== "Disabled" &&
        (rule.Expiration ||
          rule.NoncurrentVersionExpiration ||
          rule.Transitions ||
          rule.NoncurrentVersionTransitions ||
          !rule.AbortIncompleteMultipartUpload),
    )
  )
    refuse();
}
async function collectPausedDraftMetadata(
  bound,
  readers,
  phase,
  settingsToken,
) {
  const value = readToken(bound, ["bound"]);
  if (!["before_stop", "after_exclusion", "final"].includes(phase)) refuse();
  const policy =
    require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
      settingsToken,
      bound,
    );
  const nativeReaders = readers;
  readers = {
    ...nativeReaders,
    pausedDraftMetadata: (token, request) =>
      nativeReaders.pausedDraftMetadata(token, settingsToken, request),
  };
  const { parents, segments } = await collectDraftRows(bound, readers, value);
  const objects = await collectDraftObjects(
    bound,
    readers,
    value,
    parents,
    segments,
  );
  await assertDraftStorage(bound, readers);
  const markers = [];
  for (const id of value.identities)
    markers.push(
      (await readers.read({
        pk: `UPLOAD#${id.uploadId}`,
        sk: "PAUSED_DRAFT",
      })) ?? null,
    );
  readToken(bound);
  require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
    settingsToken,
    bound,
  );
  return issue({
    ...value,
    settingsToken,
    policy,
    phase,
    parents,
    segments,
    objects,
    markers,
    observedAt: Math.floor(Date.now() / 1000),
    checksumEvidence: objects.every(
      (o) =>
        o.checksumType === "FULL_OBJECT" && Object.keys(o.checksums).length > 0,
    )
      ? "provider_full_object_checksum"
      : "UNKNOWN",
  });
}
function reconcile(value, snapshot) {
  if (
    snapshot.observedAt < value.observedAt ||
    snapshot.observedAt >= value.validUntil ||
    !["personalJob", "personalSegment", "meetingHistory"].every((table) =>
      snapshot.coverage.some(
        (c) => c.table === table && c.status === "enumerated",
      ),
    )
  )
    refuse();
  const ids = value.identities.map((id) => id.uploadId);
  if (
    snapshot.records.some(
      (r) =>
        r.table === "meetingHistory" &&
        ids.includes(r.metadata.canonicalWriter?.uploadId),
    )
  )
    refuse();
  for (const [table, rows] of [
    ["personalJob", value.parents],
    ["personalSegment", value.segments],
  ]) {
    const entries = snapshot.records.filter(
      (r) => r.table === table && ids.includes(r.key.uploadId),
    );
    if (entries.length !== rows.length) refuse();
    for (const row of rows) {
      const entry = entries.find(
        (r) =>
          r.key.uploadId === row.uploadId &&
          (table !== "personalSegment" || r.key.segmentKey === row.segmentKey),
      );
      if (
        !entry ||
        Object.entries(entry.metadata).some(
          ([key, v]) => canonicalHash(v) !== canonicalHash(row[key]),
        )
      )
        refuse();
    }
  }
}
function pausedDigestsFor(value, policy) {
  return {
    cohortSha256: canonicalHash({
      identities: value.identities,
      parents: value.capture.parents,
      segments: value.capture.segments,
      objects: value.capture.objects,
      captureSha256: value.declaration.capture.sha256,
    }),
    captureSha256: value.declaration.capture.sha256,
    policyScopeSha256: policy.scopeSha256,
  };
}
function assertInstallablePausedCohort(
  token,
  globalSnapshot,
  exclusion,
  settingsToken,
) {
  const value = readToken(token, ["before_stop", "after_exclusion"]);
  reconcile(value, globalSnapshot);
  if (value.markers.some(Boolean)) refuse();
  const policy =
    require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
      settingsToken ?? value.settingsToken,
      token,
      "introduction",
    );
  if (value.phase === "after_exclusion") {
    const result =
      require("./production-inventory.cjs").compareProcessExclusion(exclusion);
    if (result.blockers.length || exclusion.after.observedAt > value.observedAt)
      refuse();
  }
  return issue({
    ...value,
    acquisitionPhase: value.phase,
    phase: "installable",
    policy,
    digests: pausedDigestsFor(value, policy),
  });
}
function pausedInitializationGuards(token, createdAt) {
  const value = readToken(token, ["installable"]);
  if (
    value.acquisitionPhase !== "after_exclusion" ||
    value.purpose !== "introduction"
  )
    refuse();
  const policy =
    require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
      value.settingsToken,
      token,
      "introduction",
    );
  return {
    ...pausedDigestsFor(value, policy),
    parents: value.parents,
    segments: value.segments,
    markers: value.identities.map((id) =>
      contract.markerSchema.parse({
        uploadId: id.uploadId,
        ownerUserId: id.ownerUserId,
        pk: `UPLOAD#${id.uploadId}`,
        sk: "PAUSED_DRAFT",
        recordType: "paused_desktop_draft",
        protocolVersion: 1,
        operationId: value.manifest.operationId,
        manifestSha256: value.manifestHash,
        preservedCaptureSha256: value.declaration.capture.sha256,
        createdAt,
      }),
    ),
  };
}
async function collectPreservedPausedCohort(
  bound,
  readers,
  installation,
  globalSnapshot,
  settingsToken,
) {
  const token =
      tokens.get(bound)?.phase === "final"
        ? bound
        : await collectPausedDraftMetadata(
            bound,
            readers,
            "final",
            settingsToken,
          ),
    value = readToken(token, ["final"]);
  reconcile(value, globalSnapshot);
  const proof =
    require("./production-actions.cjs").readOriginalPausedInstallation(
      installation,
      readPausedReaderScope(token),
    );
  if (
    canonicalHash(proof.digests) !==
    canonicalHash(pausedDigestsFor(value, value.policy))
  )
    refuse();
  for (let i = 0; i < value.identities.length; i++) {
    const marker = contract.markerSchema.parse(value.markers[i]);
    if (canonicalHash(marker) !== canonicalHash(proof.markers[i])) refuse();
  }
  return issue({ ...value, phase: "preserved", digests: proof.digests });
}
function readPausedCohort(token, phase) {
  const { binding, settingsToken, ...view } = readToken(token, [phase]);
  void binding;
  void settingsToken;
  return view;
}
function pausedCategory(token, entry, snapshot) {
  if (!token) return undefined;
  const value = readToken(token, ["installable", "preserved"]);
  reconcile(value, snapshot);
  if (
    !["personalJob", "personalSegment"].includes(entry.table) ||
    !value.identities.some((id) => id.uploadId === entry.key.uploadId)
  )
    return undefined;
  return value.phase === "preserved"
    ? "preserved_paused_desktop_draft"
    : value.acquisitionPhase === "after_exclusion"
      ? "requires_atomic_pause_install"
      : "installable_paused_desktop_draft";
}
function pausedRetainedGuards(token) {
  const value = readToken(token, ["preserved"]);
  const parents = value.parents.map((row) => ({
    table: value.manifest.resources.tables.personalJob,
    key: { uploadId: row.uploadId },
    row,
    fields: contract.parentFields.filter((key) => key !== "sourceManifest"),
    pausedParent: true,
    maximumItemBytes: 400 * 1024,
  }));
  const segments = value.segments.map((row) => ({
    table: value.manifest.resources.tables.personalSegment,
    key: { uploadId: row.uploadId, segmentKey: row.segmentKey },
    row,
    fields: contract.segmentFields.filter((key) => key !== "label"),
    maximumItemBytes: 400 * 1024,
  }));
  const markers = value.markers.map((row) => ({
    table: value.manifest.resources.tables.deploymentControl,
    key: { pk: row.pk, sk: row.sk },
    row,
    fields: Object.keys(row),
    maximumItemBytes:
      require("../../dist/services/productionAcceptanceConditions.js").completeItemSizeBound(
        row,
      ),
  }));
  return [...parents, ...segments, ...markers];
}
module.exports = {
  bindOriginalPausedDisposition,
  collectPausedDraftMetadata,
  assertInstallablePausedCohort,
  collectPreservedPausedCohort,
  readPausedCohort,
  readPausedReaderScope,
  pausedDigestsFor,
  pausedInitializationGuards,
  pausedCategory,
  pausedRetainedGuards,
};
