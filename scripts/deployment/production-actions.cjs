"use strict";
const {
  createIntroductionJournal,
  createProductionIntroductionJournal,
} = require("./introduction-transitions.cjs");
const { createIntroductionHold } = require("./introduction-hold.cjs");
const {
  canonicalHash,
  assertBoundExecution,
} = require("./production-manifest.cjs");
function createProductionActions(options) {
  const { binding, read, now } = options,
    m = binding.manifest,
    holdApi = createIntroductionHold(options);
  const key = (id) => ({
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: `ACTION#${id}`,
  });
  async function state() {
    return holdApi.readState(binding);
  }
  async function unsettled(except) {
    const j = createIntroductionJournal({ ...options, ...(await state()) });
    for (const a of m.actions) {
      const raw = await read(key(a.actionId));
      const row = raw ? await j.readAction(a.actionId) : undefined;
      if (row && row.phase !== "observed" && a.actionId !== except)
        throw Error("introduction_recovery_required");
    }
  }
  async function journal(a) {
    const current = await state();
    return (
      a.kind === "introduction_write"
        ? createProductionIntroductionJournal
        : createIntroductionJournal
    )({ ...options, ...current });
  }
  async function run(action, context, observe) {
    if (!action) throw Error("finite_action_capacity_exhausted");
    assertBoundExecution(binding, now());
    const j = await journal(action);
    let row = await read(key(action.actionId));
    if (row) {
      row = await j.readAction(action.actionId);
      if (row.phase === "submitted")
        throw Error("introduction_recovery_required");
    }
    if (row?.phase === "observed") {
      await observe();
      return row;
    }
    if (row?.phase !== "acknowledged") {
      await unsettled(action.actionId);
      await state();
      if (!row) await j.reserveAction(action.actionId, context);
      await j.submitOnce(action.actionId, context);
    }
    const value = await observe();
    return j.observe(
      action.actionId,
      action.kind === "introduction_write"
        ? introductionObservation(action, value, options.pausedDigests)
        : value,
    );
  }
  async function consume(kind, predicate, context, observe) {
    for (const a of m.actions.filter((a) => a.kind === kind && predicate(a))) {
      const row = await read(key(a.actionId));
      if (!row || row.phase !== "observed") return run(a, context, observe);
    }
    throw Error("finite_action_capacity_exhausted");
  }
  return {
    run,
    consume,
    state,
    unsettled,
    readAction: async (a) => (await journal(a)).readAction(a.actionId),
  };
}
function introductionObservation(action, value, pausedDigests) {
  let facts;
  if (
    ["initialize", "promote", "replace_control", "renew"].includes(
      action.purpose,
    )
  )
    facts = {
      kind: "control",
      control: value,
      ...(action.purpose === "initialize" && pausedDigests
        ? { paused: pausedDigests }
        : {}),
    };
  else if (action.purpose === "retire_failed")
    facts = { kind: "runtime", runtime: value };
  return {
    purpose: action.purpose,
    stateHash: canonicalHash(value),
    ...(facts ? { facts } : {}),
  };
}
const installations = new WeakMap();
const same = require("node:util").isDeepStrictEqual;
function installationRefused() {
  throw Error("paused_installation_journal_prerequisite");
}
function originalAuthority(binding, digests) {
  const m = binding.manifest;
  const actor = `arn:aws:sts::${m.identity.accountId}:assumed-role/${m.identity.roleArn.split(":role/")[1]}/${m.identity.sessionName}`;
  return require("../../dist/services/productionIntroductionTransactions.js").introductionAuthoritySchema.parse(
    require("./introduction-hold.cjs").authorityFor(
      { ...binding, actor },
      digests,
    ),
  );
}
function checkedInstallationAction(raw, action, authority, now) {
  const row =
    require("../../dist/services/productionIntroductionTransactions.js").introductionActionSchema.parse(
      raw,
    );
  if (
    row.phase !== "observed" ||
    row.actionId !== action.actionId ||
    row.kind !== action.kind ||
    row.intentHash !== authority.actions[action.actionId]?.intentHash ||
    [
      "holdId",
      "introductionId",
      "manifestHash",
      "operationId",
      "revision",
      "actor",
      "runToken",
    ].some((key) => row[key] !== authority[key])
  )
    installationRefused();
  const times = [
    row.reservedAt,
    row.submittedAt,
    row.acknowledgedAt,
    row.observedAt,
  ];
  if (
    times.some(
      (at, index) =>
        at < authority.validFrom ||
        at >= authority.validUntil ||
        at > now ||
        (index > 0 && at < times[index - 1]),
    ) ||
    !Number.isSafeInteger(row.acknowledgedAtMilliseconds) ||
    Math.floor(row.acknowledgedAtMilliseconds / 1000) !== row.acknowledgedAt
  )
    installationRefused();
  return row;
}
async function nativeInstallation(settings, bound, readers) {
  const drafts = require("./production-paused-drafts.cjs"),
    scope = drafts.readPausedReaderScope(bound),
    policy =
      require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
        settings,
        bound,
      ),
    digests = drafts.pausedDigestsFor(scope, policy),
    authority = originalAuthority(scope, digests),
    m = scope.manifest,
    now = Math.floor(Date.now() / 1000);
  if (
    !same(await readers.read({ pk: authority.pk, sk: authority.sk }), authority)
  )
    installationRefused();
  const actions = m.actions.filter(
    (a) => a.kind === "introduction_write" && a.purpose === "initialize",
  );
  if (actions.length !== 1) installationRefused();
  const action = actions[0],
    row = checkedInstallationAction(
      await readers.read({ pk: authority.pk, sk: `ACTION#${action.actionId}` }),
      action,
      authority,
      now,
    ),
    receipt = await readers.read({ pk: authority.pk, sk: "INITIALIZATION" }),
    cold = assertInstallationFacts(row, receipt, digests, scope),
    markers = await readInstallationMarkers(scope, readers, digests, row),
    lineage = await readInstallationLineage(
      receipt,
      m,
      authority,
      readers,
      row,
      now,
    );
  verifyInitializationRequest({
    scope,
    authority,
    action,
    row,
    receipt,
    cold,
    markers,
    digests,
    lineage,
  });
  return { scope, digests, markers, row, receipt };
}
function assertInstallationFacts(row, receipt, digests, scope) {
  const cold = row.acknowledgment.facts,
    m = scope.manifest;
  if (
    cold?.kind !== "cold_exclusion" ||
    !same(cold.paused, digests) ||
    cold.scopeHash !== scope.manifestHash ||
    cold.services[0]?.serviceArn !== m.runtime.serviceArn ||
    !m.runtime.legacyTaskArns.every((arn) =>
      cold.tasks.some((task) => task.taskArn === arn),
    ) ||
    cold.observedAt > row.submittedAt
  )
    installationRefused();
  assertInstallationObservation(row, receipt, digests, cold);
  return cold;
}
function assertInstallationObservation(row, receipt, digests, cold) {
  if (
    row.observation.facts?.kind !== "control" ||
    !same(row.observation.facts.paused, digests) ||
    !same(row.observation.facts.control, cold.control) ||
    !same(receipt?.paused, digests) ||
    !Array.isArray(receipt.actions)
  )
    installationRefused();
}
async function readInstallationMarkers(scope, readers, digests, row) {
  const markers = [],
    m = scope.manifest;
  for (const id of scope.identities) {
    const marker = require("./paused-draft-contract.cjs").markerSchema.parse(
      await readers.read({ pk: `UPLOAD#${id.uploadId}`, sk: "PAUSED_DRAFT" }),
    );
    if (
      marker.ownerUserId !== id.ownerUserId ||
      marker.operationId !== m.operationId ||
      marker.manifestSha256 !== scope.manifestHash ||
      marker.preservedCaptureSha256 !== digests.captureSha256 ||
      marker.createdAt > row.submittedAt
    )
      installationRefused();
    markers.push(marker);
  }
  return markers;
}
async function readInstallationLineage(
  receipt,
  m,
  authority,
  readers,
  row,
  now,
) {
  const lineage = [];
  for (const entry of receipt.actions) {
    const declared = m.actions.find((a) => a.actionId === entry.actionId);
    if (!declared) installationRefused();
    const prior = checkedInstallationAction(
      await readers.read({ pk: authority.pk, sk: `ACTION#${entry.actionId}` }),
      declared,
      authority,
      now,
    );
    if (
      prior.requestHash !== entry.requestHash ||
      prior.observedAt > row.submittedAt
    )
      installationRefused();
    lineage.push(prior);
  }
  return lineage;
}
function verifyInitializationRequest({
  scope,
  authority,
  action,
  row,
  receipt,
  cold,
  markers,
  digests,
  lineage,
}) {
  const m = scope.manifest,
    hold = {
      pk: "ENV",
      sk: "INTRODUCTION",
      recordType: "production_introduction",
      protocolVersion: 1,
      holdId: m.holdId,
      introductionId: m.introductionId,
      manifestHash: scope.manifestHash,
      revision: 1,
      admission: { state: "held" },
      deployment: { state: "held" },
    },
    paused = {
      ...digests,
      parents: scope.capture.parents,
      segments: scope.capture.segments,
      markers,
    },
    recipe =
      require("./production-introduction-recipes.cjs").introductionRecipes({
        hold,
        authority,
        table: m.resources.tables.deploymentControl,
      }),
    wire = recipe.request(m, action, {
      control: cold.control,
      lineage,
      paused,
      coldExclusion: cold,
    }),
    expectedReceipt = wire.input.TransactItems.find(
      (item) => item.Put?.Item?.sk?.S === "INITIALIZATION",
    );
  if (
    !expectedReceipt ||
    !same(
      require("@aws-sdk/util-dynamodb").unmarshall(expectedReceipt.Put.Item),
      receipt,
    ) ||
    canonicalHash(wire) !== row.requestHash ||
    !same(
      recipe.acknowledgment(
        m,
        action,
        {},
        { paused, coldExclusion: cold },
        wire,
      ),
      row.acknowledgment,
    ) ||
    !same(
      recipe.observation(m, action, {
        purpose: "initialize",
        stateHash: canonicalHash(cold.control),
        facts: { kind: "control", control: cold.control, paused: digests },
      }),
      row.observation,
    )
  )
    installationRefused();
}
async function collectOriginalPausedInstallationFromRun() {
  const packages = require("./production-private-package.cjs"),
    loaded = ["prepare-acceptance", "accept"].includes(process.env.GITHUB_JOB)
      ? await packages.loadAcceptancePackage()
      : await packages.loadProductionPackage(
          process.env,
          require("./coordinator-aws.cjs").awsCli,
          process.env.GITHUB_JOB,
        ),
    authority = loaded.collection ?? loaded.binding,
    bound =
      require("./production-paused-drafts.cjs").bindOriginalPausedDisposition(
        authority,
        loaded.evidence,
        loaded.pausedPreparation,
      ),
    settings =
      await require("./production-launcher-settings.cjs").collectLauncherSettingsFromOriginalRun(),
    providers = require("./production-aws.cjs"),
    readers = loaded.collection
      ? providers.createAcceptanceReadAws(loaded.collection)
      : providers.createProductionAws(loaded.binding),
    result = await nativeInstallation(settings, bound, readers),
    token = Object.freeze({});
  installations.set(token, { authority, settings, bound, result });
  return token;
}
function readOriginalPausedInstallation(token, cohortView) {
  const value = installations.get(token);
  if (!value) installationRefused();
  const checked =
      require("./production-paused-draft-binding.cjs").readDraftBinding(
        value.authority,
      ),
    scope = require("./production-paused-drafts.cjs").readPausedReaderScope(
      value.bound,
    ),
    policy =
      require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
        value.settings,
        value.bound,
      ),
    digests = require("./production-paused-drafts.cjs").pausedDigestsFor(
      scope,
      policy,
    );
  if (
    checked.manifestHash !== cohortView.manifestHash ||
    !same(scope.declaration, cohortView.declaration) ||
    !same(scope.capture, cohortView.capture) ||
    !same(scope.identities, cohortView.identities) ||
    !same(digests, value.result.digests)
  )
    installationRefused();
  return structuredClone({
    digests,
    markers: value.result.markers,
    action: value.result.row,
    initialization: value.result.receipt,
  });
}
module.exports = {
  createProductionActions,
  collectOriginalPausedInstallationFromRun,
  readOriginalPausedInstallation,
};
