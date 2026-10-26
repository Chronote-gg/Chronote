"use strict";
const { authorityFor } = require("./introduction-hold.cjs");
const { canonicalHash } = require("./production-manifest.cjs");
const ceiling = 400 * 1024;
const futureText = "\u0000".repeat(1024);
const digest = "f".repeat(64);
function helpers() {
  return require("../../dist/services/productionAcceptanceConditions.js");
}
function futureGrant(binding, grant) {
  const m = binding.manifest;
  return {
    ...grant,
    pk: `FIXTURE#${grant.grantId}`,
    sk: "AUTHORITY",
    recordType: "fixture_grant",
    protocolVersion: 1,
    holdId: m.holdId,
    introductionId: m.introductionId,
    revision: 1,
    state: "consumed",
    ownership: {
      guildId: grant.guildId,
      meetingId: grant.meetingId,
      ownerInstanceId: futureText,
      executionVersion: 1,
      voiceOperationAttemptId: "f".repeat(36),
      sessionMode: "meeting",
    },
    historyKey: { guildId: grant.guildId, channelId_timestamp: futureText },
  };
}
function assertSupportedGrantSize(binding, row, index) {
  // These are the existing supported writer forms: owner/history sort keys and
  // activeMeetingLeaseService's randomUUID attempt. This is not runtime authority.
  if (
    row.state !== "consumed" ||
    Buffer.byteLength(row.ownership.ownerInstanceId, "utf8") > 1024 ||
    Buffer.byteLength(row.historyKey.channelId_timestamp, "utf8") > 1024 ||
    row.ownership.voiceOperationAttemptId.length > 36 ||
    helpers().completeItemSizeBound(row) >
      helpers().completeItemSizeBound(
        futureGrant(binding, binding.manifest.handoff.grants[index]),
      )
  )
    throw Error("acceptance_capacity_refused");
}
function closingRecords(binding, purpose) {
  const m = binding.manifest,
    authority = authorityFor(binding),
    action = m.actions.find((a) => a.purpose === purpose),
    first = m.actions.find((a) => a.purpose === "persist_acceptance");
  const hold = {
    pk: "ENV",
    sk: "INTRODUCTION",
    recordType: "production_introduction",
    protocolVersion: 1,
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    revision: 1,
    fixtureGrantIds: m.handoff.grants.map((g) => g.grantId),
    admission: { state: "reopened", receiptId: first.actionId },
    deployment: { state: "released", receiptId: first.actionId },
  };
  const submitted = {
    pk: authority.pk,
    sk: `ACTION#${action.actionId}`,
    recordType: "introduction_action",
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    operationId: m.operationId,
    revision: 1,
    actor: authority.actor,
    runToken: authority.runToken,
    actionId: action.actionId,
    kind: "acceptance_write",
    intentHash: digest,
    requestHash: digest,
    predecessor: {
      actionId: m.actions
        .filter((a) => a.kind === "acceptance_write")
        .reduce(
          (longest, a) =>
            Buffer.byteLength(a.actionId) > Buffer.byteLength(longest)
              ? a.actionId
              : longest,
          "",
        ),
      receiptHash: digest,
    },
    reservedAt: Number.MAX_SAFE_INTEGER,
    phase: "submitted",
    version: 2,
    attemptId: "f".repeat(36),
    submittedAt: Number.MAX_SAFE_INTEGER,
  };
  const acceptance = {
    pk: authority.pk,
    sk: "ACCEPTANCE",
    recordType: "production_acceptance",
    protocolVersion: 1,
    acceptanceId: first.actionId,
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: binding.manifestHash,
    revision: 1,
    sourceCommit: m.identity.sourceCommit,
    originalRunId: m.identity.runId,
    originalRunAttempt: "1",
    supplementCommit: "f".repeat(40),
    supplementHash: digest,
    fixtureEvidenceHash: digest,
    historyEvidenceHash: digest,
    writerClosureHash: digest,
    retainedDispositionHash: digest,
    launcherBaselineHash: digest,
    handoffAt: "9".repeat(32),
    retiredAt: Number.MAX_SAFE_INTEGER,
    servingGeneration: Number.MAX_SAFE_INTEGER,
    servingMembersHash: digest,
  };
  return [hold, authority, submitted, acceptance];
}
function initialCapacityEnvelopes(binding, snapshot, historyKeys = []) {
  const m = binding.manifest,
    { completeItemSizeBound, assertCapacityBounds } = helpers();
  const retained = new Map(
    snapshot.records.map((r) => [
      canonicalHash({ table: m.resources.tables[r.table], key: r.key }),
      {
        table: m.resources.tables[r.table],
        key: r.key,
        maximumItemBytes: ceiling,
      },
    ]),
  );
  // The fixed fixture commands can already exist on continuation. Never count
  // a physical command twice. Known consumed grants also identify existing histories.
  for (const grant of m.handoff.grants) {
    const target = {
      table: m.resources.tables.meetingControl,
      key: { requestId: grant.commandId },
      maximumItemBytes: ceiling,
    };
    retained.set(
      canonicalHash({ table: target.table, key: target.key }),
      target,
    );
  }
  const result = [];
  for (const path of ["normal", "replacement"])
    for (const purpose of [
      "persist_acceptance",
      "reopen_admission",
      "release_deployment",
    ]) {
      const fixed = closingRecords(binding, purpose).concat(
        m.handoff.grants.map((g) => futureGrant(binding, g)),
      );
      const bounds = fixed.map((row) => ({
        table: m.resources.tables.deploymentControl,
        key: { pk: row.pk, sk: row.sk },
        maximumItemBytes: completeItemSizeBound(row),
      }));
      bounds.push(
        {
          table: m.resources.tables.deploymentControl,
          key: { pk: "ENV", sk: "CONTROL" },
          maximumItemBytes: ceiling,
        },
        {
          table: m.resources.tables.deploymentControl,
          key: {
            pk: `INTRODUCTION#${m.introductionId}`,
            sk: "FIXTURE_COORDINATOR",
          },
          maximumItemBytes: ceiling,
        },
      );
      for (let index = 0; index < (path === "normal" ? 2 : 3); index++)
        bounds.push({
          table: m.resources.tables.deploymentControl,
          key: { pk: "ENV", sk: `FUTURE_RUNTIME_BUDGET#${index}` },
          maximumItemBytes: ceiling,
        });
      const historyBounds = new Map(retained);
      for (let index = 0; index < 2; index++) {
        const target = {
          table: m.resources.tables.meetingHistory,
          key: historyKeys[index] ?? {
            guildId: m.handoff.grants[index].guildId,
            channelId_timestamp: `FUTURE_HISTORY_BUDGET#${index}`,
          },
          maximumItemBytes: ceiling,
        };
        historyBounds.set(
          canonicalHash({ table: target.table, key: target.key }),
          target,
        );
      }
      bounds.push(...historyBounds.values());
      // Observed action rows have no supported successor/overwrite/delete/TTL.
      // All 200 original actions and all selected renewals are still authenticated
      // by readIntroductionHistory. No historical row becomes a mutable target.
      assertCapacityBounds(bounds);
      result.push({
        path,
        purpose,
        targets: bounds.length,
        maximumItemBytes: bounds.reduce(
          (sum, b) => sum + b.maximumItemBytes,
          0,
        ),
      });
    }
  return result;
}
async function screenInitialAcceptanceCapacity(options) {
  const { readRetainedMetadata, projections } = require("./retained-work.cjs");
  const snapshot = await readRetainedMetadata({
    tables: options.binding.manifest.resources.tables,
    read: options.scan,
    now: options.now(),
  });
  if (
    snapshot.coverage.length !== Object.keys(projections).length ||
    snapshot.coverage.some((c) => c.status !== "enumerated")
  )
    throw Error("acceptance_capacity_refused");
  const keys = [];
  const {
    fixtureGrantSchema,
  } = require("../../dist/types/productionIntroduction.js");
  const m = options.binding.manifest;
  for (const [index, grant] of m.handoff.grants.entries()) {
    const row = await options.read({
      pk: `FIXTURE#${grant.grantId}`,
      sk: "AUTHORITY",
    });
    if (!row) continue;
    fixtureGrantSchema.parse(row);
    const expected = {
      ...grant,
      holdId: m.holdId,
      introductionId: m.introductionId,
      revision: 1,
    };
    if (Object.entries(expected).some(([key, value]) => row[key] !== value))
      throw Error("acceptance_capacity_refused");
    if (row.state === "consumed") {
      assertSupportedGrantSize(options.binding, row, index);
      keys[index] = row.historyKey;
    }
  }
  return initialCapacityEnvelopes(options.binding, snapshot, keys);
}
module.exports = {
  initialCapacityEnvelopes,
  screenInitialAcceptanceCapacity,
  assertSupportedGrantSize,
};
