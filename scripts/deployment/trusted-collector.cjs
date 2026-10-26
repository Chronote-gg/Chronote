"use strict";
const assert = require("node:assert/strict");
const { ECSClient } = require("@aws-sdk/client-ecs");
const { parseProductionManifest } = require("./production-manifest.cjs");
const { parseRehearsalManifest } = require("./rehearsal-manifest.cjs");
const { awsCaller } = require("./sandbox-manifest.cjs");
const { verifyCollectorRequest } = require("./collector-command.cjs");
const { nativeTransport } = require("./collector-native.cjs");
const { collectPausedDrafts } = require("./paused-draft-capture.cjs");
const { collectNativeInventory } = require("./collector-inventory.cjs");
const { collectRehearsalTags } = require("./collector-tags.cjs");
const { collectTaskSession } = require("./collector-session.cjs");
const { createPrivateCapture } = require("./private-capture.cjs");
const { metadataDigest } = require("./production-work.cjs");
const { buildProbeRequests } = require("./maintenance-probe.cjs");
function collectionBlockers(snapshot) {
  const blockers = [
    "non_service_writer_freeze_unproved",
    "recovery_publication_apply_process_and_nonexpiring_claims_unproved",
    "recovery_publication_reconcile_process_and_nonexpiring_intents_unproved",
    "cached_application_credentials_unproved",
    "custom_storage_credentials_and_endpoint_compatibility_unproved",
    "external_effect_settlement_unproved",
    "complete_controller_source_scope_unproved",
  ];
  for (const [slot, rows] of Object.entries(snapshot.tables))
    if (rows.length) blockers.push(`row_bound_${slot}_settlement_unproved`);
  if (snapshot.tables.uploads.length || snapshot.tables.segments.length)
    blockers.push("immutable_objects_tokens_schema_compatibility_unproved");
  return blockers;
}
function createTrustedCollector(options) {
  const { manifest, expectedSha256, storageBinding } = options;
  const m =
    manifest.kind === "rehearsal-introduction"
      ? parseRehearsalManifest(manifest, expectedSha256)
      : parseProductionManifest(manifest, expectedSha256);
  const store = createPrivateCapture({
    m,
    manifestSha256: expectedSha256,
    binding: storageBinding,
    client: options.s3,
    now: options.now,
  });
  const aws = options.aws ?? awsCaller(m.binding.region),
    now = options.now ?? (() => Date.now() / 1000);
  const ecs =
    options.ecs ??
    new ECSClient({
      region: m.binding.region,
      maxAttempts: 1,
      endpoint: `https://ecs.${m.binding.region}.amazonaws.com`,
    });
  const submitted = new Set();
  const probe = async (request, snapshot) => {
    verifyCollectorRequest(m, request);
    assert.equal(request.operationId, m.binding.operationId);
    assert.equal(request.manifestSha256, expectedSha256);
    assert.equal(request.roleArn, m.binding.taskRoleArn);
    assert.ok(
      ["fence", "drain", "activate", "abort", "reconcile", "complete"].includes(
        request.phase,
      ),
    );
    assert.equal(request.snapshotSha256, metadataDigest(snapshot));
    assert.deepEqual(snapshot.binding, m.binding);
    assert.equal(
      request.probeRequestsSha256,
      metadataDigest(buildProbeRequests(m.binding)),
    );
    assert.ok(now() < request.validUntil && request.validUntil <= m.validUntil);
    assert.match(request.nonce, /^[a-f0-9-]{36}$/);
    assert.ok(
      !submitted.has(request.nonce),
      "UNKNOWN: observation already submitted; do not retry",
    );
    submitted.add(request.nonce);
    const boundedAws = nativeTransport(
      aws,
      request.validUntil,
      () => now() * 1000,
    );
    const native = await collectNativeInventory({
      m,
      request,
      aws: boundedAws,
    });
    const tags = await collectRehearsalTags(boundedAws, m);
    assert.ok(now() < request.validUntil, "UNKNOWN: observation expired");
    const session =
      native.tasks.bound.lastStatus === "STOPPED"
        ? null
        : await collectTaskSession({
            m,
            request,
            native: native.tasks.bound,
            ecs,
          });
    const pausedDrafts = await collectPausedDrafts({
      ...options,
      m,
      aws: boundedAws,
      now,
      snapshot,
      validUntil: request.validUntil,
    });
    const blockers = collectionBlockers(snapshot);
    assert.ok(now() < request.validUntil, "UNKNOWN: observation expired");
    const capture = await store.capture({
      kind: "blocked-native-observation-v1",
      request,
      snapshot,
      native,
      tags,
      session,
      ...(pausedDrafts
        ? { compatibility: { binding: m.binding, uploads: [], pausedDrafts } }
        : {}),
      observedAt: Math.floor(now()),
      blockers,
    });
    const error = new Error(
      "UNKNOWN: trusted collection retained unresolved external prerequisites",
    );
    error.code = "collector_prerequisites_unavailable";
    error.blockers = blockers;
    error.capture = capture;
    throw error;
  };
  return Object.assign(probe, store);
}
module.exports = { createTrustedCollector, collectionBlockers };
