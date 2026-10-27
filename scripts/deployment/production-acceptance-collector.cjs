"use strict";
const { isDeepStrictEqual: same } = require("node:util");
const { canonicalHash } = require("./production-manifest.cjs");
const {
  readIntroductionHistory,
  verifyHistoricalCapture,
  assertHistoricalRuntimes,
} = require("./production-acceptance-history.cjs");
const {
  assertAcceptanceWriters,
  readRuntimeInventory,
} = require("./production-acceptance-inventory.cjs");
const { collectAcceptanceInventory } = require("./production-inventory.cjs");
const { createInventoryReader } = require("./production-inventory-adapter.cjs");
const {
  collectRetainedClosure,
  mergeGuards,
} = require("./production-acceptance-retained.cjs");
const tokens = new WeakMap();
function refuse() {
  throw Error("acceptance_authority_prerequisite");
}
const now = () => Math.floor(Date.now() / 1000);
function current(value) {
  const m = value.f.binding.manifest,
    at = now();
  if (at < m.validFrom || at >= value.f.deadline || at >= m.validUntil)
    refuse();
  // Native protection and heartbeat proof must remain usable through synchronous dispatch.
  assertAcceptanceWriters({ ...value.state, now: at });
  if (value.pausedContext) {
    require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
      value.pausedContext.settingsToken,
      value.pausedContext.bound,
    );
    require("./production-actions.cjs").readOriginalPausedInstallation(
      value.pausedContext.installation,
      require("./production-paused-drafts.cjs").readPausedReaderScope(
        value.pausedContext.bound,
      ),
    );
  }
}
async function readCurrentRoute(m, readers) {
  const route = {
    listenerArn: m.resources.listenerArn,
    sourceGroup: m.resources.targetGroupA,
    candidateGroup: m.resources.targetGroupB,
  };
  const { createRouting } = require("./routing.cjs");
  const routing = createRouting({
    aws: readers.aws,
    config: {},
    env: {},
    failure: () => Error("acceptance_route_prerequisite"),
  });
  await routing.assertAction(route, true);
  const r = await readers.aws("ecs", "describe-services", {
    cluster: m.runtime.clusterArn,
    services: [m.runtime.serviceArn],
  });
  if (r.failures?.length || r.services?.length !== 1) refuse();
  const s = r.services[0];
  if (
    s.taskDefinition !== m.runtime.continuationDefinition ||
    s.desiredCount !== 1 ||
    s.pendingCount !== 0 ||
    s.deploymentController?.type !== "ECS" ||
    !same(s.loadBalancers, [
      {
        targetGroupArn: m.resources.targetGroupB,
        containerName: m.runtime.container,
        containerPort: 3001,
      },
    ])
  )
    refuse();
}
function baseline(f, history, launcher) {
  const stop = history.entries.find(
    ({ action }) => action.kind === "stop_service",
  )?.row;
  const original = stop?.acknowledgment.facts?.launcherBaseline;
  if (
    !original ||
    original.baselineHash !== launcher.baselineHash ||
    original.manifestHash !== launcher.manifestHash ||
    original.sourceCommit !== launcher.sourceCommit ||
    original.observedAt > stop.submittedAt ||
    original.observedAt < f.binding.manifest.validFrom ||
    !same(original.coverage, launcher.coverage)
  )
    refuse();
}
function assertFinalRowIdentity(row, action, authority) {
  if (
    row.phase !== "observed" ||
    row.kind !== "acceptance_write" ||
    row.intentHash !== authority.actions[action.actionId].intentHash ||
    row.manifestHash !== authority.manifestHash ||
    row.actor !== authority.actor ||
    row.operationId !== authority.operationId ||
    row.runToken !== authority.runToken ||
    row.actionId !== action.actionId
  )
    refuse();
}
function assertFinalRowFacts(row, action, acceptanceId) {
  if (
    row.acknowledgment.facts?.kind !== "acceptance_transition" ||
    row.acknowledgment.facts.purpose !== action.purpose ||
    row.acknowledgment.facts.acceptanceId !== acceptanceId ||
    !same(row.observation.facts, row.acknowledgment.facts) ||
    row.acknowledgedAt < row.submittedAt ||
    row.observedAt < row.acknowledgedAt ||
    row.observedAt > now()
  )
    refuse();
}
function assertFinalPredecessor(row, prior) {
  if (
    prior
      ? row.predecessor?.receiptHash !== prior.observation.evidenceHash ||
        row.predecessor.actionId !== prior.actionId ||
        row.reservedAt < prior.observedAt
      : row.predecessor !== null
  )
    refuse();
}
async function finalStage(m, readers, history) {
  const actions = m.actions.filter((a) => a.kind === "acceptance_write"),
    rows = [];
  let missing = false;
  for (const action of actions) {
    const raw = await readers.read({
      pk: history.authority.pk,
      sk: `ACTION#${action.actionId}`,
    });
    if (raw) {
      if (missing) refuse();
      const row =
        require("../../dist/services/productionIntroductionTransactions.js").introductionActionSchema.parse(
          raw,
        );
      assertFinalRowIdentity(row, action, history.authority);
      assertFinalRowFacts(row, action, actions[0].actionId);
      assertFinalPredecessor(row, rows.at(-1));
      rows.push(row);
    } else missing = true;
  }
  if (rows.length >= actions.length) refuse();
  return { action: actions[rows.length], rows };
}
function record(f, history, writers) {
  const m = f.binding.manifest;
  return {
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: "ACCEPTANCE",
    recordType: "production_acceptance",
    protocolVersion: 1,
    acceptanceId: m.actions.find((a) => a.purpose === "persist_acceptance")
      .actionId,
    holdId: m.holdId,
    introductionId: m.introductionId,
    manifestHash: f.binding.manifestHash,
    revision: 1,
    sourceCommit: m.identity.sourceCommit,
    originalRunId: m.identity.runId,
    originalRunAttempt: "1",
    supplementCommit: f.pinned.supplementCommit,
    supplementHash: f.pinned.supplementHash,
    fixtureEvidenceHash: canonicalHash(
      f.fixtures.map((v) => ({
        metadata: v.metadata,
        review: f.supplement.fixtures.find(
          (r) => r.grantId === v.metadata.grant.grantId,
        ),
        fallbackSource: v.fallbackSource,
      })),
    ),
    historyEvidenceHash: canonicalHash(history.entries),
    writerClosureHash: canonicalHash(
      writers.map(({ identity, sourceCommit }) => ({ identity, sourceCommit })),
    ),
    retainedDispositionHash: m.prerequisites.retainedDisposition,
    launcherBaselineHash: m.prerequisites.launcherHolds,
    handoffAt: history.handoffAt,
    retiredAt: history.retiredAt,
    servingGeneration: f.control.servingGeneration,
    servingMembersHash: canonicalHash(f.control.servingMembers),
  };
}
async function collectAcceptanceFromOriginalRun() {
  const {
    loadAcceptancePackage,
    readCollectionBinding,
    verifyOwnershipEvidence,
  } = require("./production-private-package.cjs");
  const loaded = await loadAcceptancePackage();
  const binding = loaded.collection
    ? readCollectionBinding(loaded.collection)
    : loaded.binding;
  const readers = loaded.collection
    ? require("./production-aws.cjs").createAcceptanceReadAws(loaded.collection)
    : require("./production-aws.cjs").createProductionAws(binding);
  const content = require("./production-fixture-content.cjs");
  const f = content.readGeneratedFixtures(
    await content.collectGeneratedFixturesFromOriginalRun(),
  );
  if (!same(f.binding, binding)) refuse();
  const m = binding.manifest;
  const launchers = require("./production-launcher-settings.cjs");
  const launcherSettingsToken =
    await launchers.collectLauncherSettingsFromOriginalRun();
  const launcher = launchers.readLauncherSettings(
    launcherSettingsToken,
    binding,
  );
  let pausedContext;
  if (loaded.pausedPreparation) {
    const drafts = require("./production-paused-drafts.cjs");
    const bound = drafts.bindOriginalPausedDisposition(
      loaded.collection ?? loaded.binding,
      loaded.evidence,
      loaded.pausedPreparation,
    );
    const scope = drafts.readPausedReaderScope(bound);
    f.pausedDigests = drafts.pausedDigestsFor(
      scope,
      launchers.readPausedEffectivePolicyScope(launcherSettingsToken, bound),
    );
    pausedContext = {
      bound,
      settingsToken: launcherSettingsToken,
      installation:
        await require("./production-actions.cjs").collectOriginalPausedInstallationFromRun(),
    };
  }
  const history = await readIntroductionHistory(f, readers, now());
  baseline(f, history, launcher);
  verifyHistoricalCapture(f, history);
  const runtimes = await readRuntimeInventory(m, readers);
  const inventory = await collectAcceptanceInventory({
    scope: m,
    read: createInventoryReader(m, readers.aws).read,
    now: now(),
    declaredRoutes:
      require("./production-source-routes.cjs").verifyDeclaredRoutes(binding),
    expectedTaskArns: runtimes.map((r) => r.identity.taskArn),
  });
  const state = {
    m,
    control: f.control,
    fixtureAuthority: f.fixtureAuthority,
    runtimes,
    inventory,
    now: now(),
  };
  const writers = assertAcceptanceWriters(state);
  assertHistoricalRuntimes(history, state);
  await readCurrentRoute(m, readers);
  const value = {
    f,
    loaded,
    readers,
    launcher,
    launcherSettingsToken,
    pausedContext,
    history,
    state,
    writers,
  };
  current(value);
  if (!loaded.collection) {
    value.stage = await finalStage(m, readers, history);
    value.acceptance = record(f, history, writers);
    if (
      value.stage.action.purpose === "release_deployment"
        ? f.hold.admission.state !== "reopened" ||
          f.hold.admission.receiptId !== value.acceptance.acceptanceId ||
          f.control.maintenance !== undefined
        : f.hold.admission.state !== "held"
    )
      refuse();
    require("../../dist/services/productionAcceptanceTransactions.js").acceptanceRecordSchema.parse(
      value.acceptance,
    );
    const stored = await readers.read({
      pk: value.acceptance.pk,
      sk: "ACCEPTANCE",
    });
    if (
      value.stage.rows.length
        ? !same(stored, value.acceptance)
        : stored !== undefined
    )
      refuse();
    const compatibility = await verifyOwnershipEvidence(
      binding,
      loaded.evidence,
      process.env.GH_TOKEN,
    );
    value.retained = await collectRetainedClosure(
      f,
      loaded,
      readers,
      writers,
      compatibility,
      now(),
      pausedContext,
    );
  }
  if (loaded.collection && pausedContext) {
    const compatibility = await verifyOwnershipEvidence(
      binding,
      loaded.evidence,
      process.env.GH_TOKEN,
    );
    value.retained = await collectRetainedClosure(
      f,
      loaded,
      readers,
      writers,
      compatibility,
      now(),
      pausedContext,
    );
  }
  current(value);
  const token = Object.freeze({});
  tokens.set(token, value);
  return token;
}
function waitForPreparedAcceptance() {
  return require("./production-prepare-wait.cjs").waitWithinOriginalPreparation(
    collectAcceptanceFromOriginalRun,
  );
}
function currentAcceptance(token) {
  const value = tokens.get(token);
  if (!value) refuse();
  current(value);
  return value;
}
function acceptanceSummary(token) {
  const v = currentAcceptance(token);
  return {
    status: "prepared",
    retainedWorkClassification: v.loaded.collection ? "UNVERIFIED" : "verified",
    supplementCommit: v.f.pinned.supplementCommit,
    supplementHash: v.f.pinned.supplementHash,
    originalValidityEndsAt: v.f.binding.manifest.validUntil,
    fixtureFingerprints: v.f.fixtures.map((fixture, index) => ({
      index: index + 1,
      fingerprint: canonicalHash(fixture.metadata).slice(0, 16),
    })),
  };
}
function transactionInputs(token, submitted) {
  const v = currentAcceptance(token);
  if (v.loaded.collection || !v.retained) refuse();
  const { f, history, state, retained, stage, acceptance, launcher } = v,
    m = f.binding.manifest;
  if (submitted.actionId !== stage.action.actionId) refuse();
  const {
    completeItemSizeBound,
  } = require("../../dist/services/productionAcceptanceConditions.js");
  const guards = [];
  const add = (row, fields = Object.keys(row)) =>
    guards.push({
      table: m.resources.tables.deploymentControl,
      key: { pk: row.pk, sk: row.sk },
      row,
      fields,
      maximumItemBytes: completeItemSizeBound(row),
    });
  const capacity = require("./production-acceptance-capacity.cjs");
  capacity.assertSupportedFixtureAuthoritySize(
    f.binding,
    f.fixtureAuthority,
    history.path,
  );
  add(f.fixtureAuthority);
  // Every original action was authenticated above. Strict observed/version 4 rows
  // have no supported successor, overwrite, delete or TTL path. Current submitted
  // action remains guarded by the final builder; mutable domain rows stay below.
  for (const row of state.runtimes) {
    capacity.assertSupportedRuntimeSize(f.binding, row);
    add(row, [
      ...new Set([
        ...Object.keys(row),
        "canonicalContentWriter",
        "workCounts",
        "expiresAt",
        "retirementRequest",
        "retirementAcknowledgment",
      ]),
    ]);
  }
  if (retained.paused) {
    require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
      v.launcherSettingsToken,
      retained.paused,
    );
    guards.push(
      ...require("./production-paused-drafts.cjs").pausedRetainedGuards(
        retained.paused,
      ),
    );
  }
  for (const entry of retained.snapshot.records) {
    if (retained.compatible.includes(entry)) continue;
    guards.push({
      table: m.resources.tables[entry.table],
      key: entry.key,
      row: entry.metadata,
      fields: require("./retained-work.cjs").retainedGuardFields(entry.table),
      presentFields:
        entry.table === "stripeWebhook"
          ? ["firstAdmission", "admission"].filter(
              (field) => entry.metadata[field] === true,
            )
          : [],
      maximumItemBytes: 400 * 1024,
    });
  }
  for (const [index, fixture] of f.fixtures.entries()) {
    require("./production-acceptance-capacity.cjs").assertSupportedGrantSize(
      f.binding,
      fixture.metadata.grant,
      index,
    );
    add(fixture.metadata.grant);
    const row = { ...fixture.metadata.history, notes: fixture.contents.notes };
    guards.push({
      table: m.resources.tables.meetingHistory,
      key: fixture.metadata.grant.historyKey,
      row,
      fields: Object.keys(row),
      maximumItemBytes: 400 * 1024,
    });
  }
  return structuredClone({
    table: m.resources.tables.deploymentControl,
    purpose: stage.action.purpose,
    hold: f.hold,
    control: f.control,
    authority: history.authority,
    action: submitted,
    acceptance,
    guards: mergeGuards(guards),
    now: now(),
    launcher,
  });
}
function readAcceptance(token) {
  const v = currentAcceptance(token);
  return structuredClone({
    f: v.f,
    history: v.history,
    stage: v.stage,
    acceptance: v.acceptance,
    launcher: v.launcher,
    preparation: !!v.loaded.collection,
  });
}
module.exports = {
  collectAcceptanceFromOriginalRun,
  waitForPreparedAcceptance,
  acceptanceSummary,
  readAcceptance,
  transactionInputs,
};
