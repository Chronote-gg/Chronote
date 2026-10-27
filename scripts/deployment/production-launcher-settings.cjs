"use strict";
const { isDeepStrictEqual: same } = require("node:util");
const { canonicalHash } = require("./production-manifest.cjs");
const {
  loadAcceptancePackage,
  loadProductionPackage,
  readCollectionBinding,
} = require("./production-private-package.cjs");
const {
  createProductionAws,
  createAcceptanceReadAws,
} = require("./production-aws.cjs");
const { awsCli } = require("./coordinator-aws.cjs");
const {
  assertDeclaration,
  refuse,
} = require("./production-launcher-schema.cjs");
const { readIamSettings } = require("./production-launcher-iam.cjs");
const { readGithubSettings } = require("./production-launcher-github.cjs");
const receipts = new WeakMap();
function current(m) {
  const now = Math.floor(Date.now() / 1000);
  if (
    now < m.validFrom ||
    now >= m.validUntil ||
    (process.env.GITHUB_JOB === "prepare-acceptance" &&
      now >= m.acceptance.prepareDeadline)
  )
    refuse();
  return now;
}
async function collectLauncherSettingsFromOriginalRun() {
  const mode = process.env.GITHUB_JOB;
  const loaded = ["prepare-acceptance", "accept"].includes(mode)
    ? await loadAcceptancePackage()
    : await loadProductionPackage(process.env, awsCli, mode);
  const binding = loaded.collection
    ? readCollectionBinding(loaded.collection)
    : loaded.binding;
  const m = binding.manifest,
    declaration = assertDeclaration(binding, loaded.evidence.launcherHolds);
  current(m);
  require("./production-source-routes.cjs").verifyDeclaredRoutes(binding);
  const readers = loaded.collection
    ? createAcceptanceReadAws(loaded.collection)
    : createProductionAws(binding);
  await readGithubSettings(
    m,
    declaration,
    process.env.INTRODUCTION_OPS_READ_TOKEN,
  );
  const roles = await readIamSettings(readers.aws, declaration);
  // Recheck the GitHub selectors after IAM document collection; neither provider is an atomic snapshot.
  await readGithubSettings(
    m,
    declaration,
    process.env.INTRODUCTION_OPS_READ_TOKEN,
  );
  const observation = {
    kind: "launcher_settings",
    mode: "zero-external-launcher-mutations",
    manifestHash: binding.manifestHash,
    baselineHash: m.prerequisites.launcherHolds,
    sourceCommit: m.identity.sourceCommit,
    observedAt: current(m),
    coverage: [
      "github_routes",
      "github_environment",
      "github_branch",
      "github_variables",
      "github_actions",
      "resumable_jobs",
      "named_roles",
      "oidc",
    ],
  };
  const authority = loaded.collection ?? loaded.binding;
  let paused;
  if (loaded.evidence.retainedDisposition?.pausedDesktopDrafts) {
    const drafts = require("./production-paused-drafts.cjs");
    const cohort = drafts.bindOriginalPausedDisposition(
      authority,
      loaded.evidence,
      loaded.pausedPreparation,
    );
    const scope = drafts.readPausedReaderScope(cohort);
    const { assertPausedPolicy } = require("./production-paused-policy.cjs");
    const principals = ["introduction", "collector"].map((purpose) =>
      assertPausedPolicy(scope, roles, purpose),
    );
    paused = {
      identity: pausedIdentity(scope),
      scope,
      principals,
      scopeSha256: canonicalHash({
        manifestHash: scope.manifestHash,
        requestHash: canonicalHash(scope.request),
        declarationHash: canonicalHash(scope.declaration),
        captureHash: scope.declaration.capture.sha256,
        principals,
        launcherBaselineHash: observation.baselineHash,
      }),
    };
  }
  const token = Object.freeze({});
  receipts.set(token, { m, observation, authority, roles, paused });
  return token;
}
function readLauncherSettings(token, binding) {
  const value = receipts.get(token);
  if (!value || (binding && !same(value.m, binding.manifest))) refuse();
  current(value.m);
  return structuredClone(value.observation);
}
function pausedIdentity(scope) {
  return canonicalHash({
    manifestHash: scope.manifestHash,
    actor: scope.actor,
    purpose: scope.purpose,
    identities: scope.identities,
    objects: scope.objects,
    request: scope.request,
    declaration: scope.declaration,
    capture: scope.capture,
  });
}
function readPausedEffectivePolicyScope(token, cohortToken, principalPurpose) {
  const value = receipts.get(token);
  if (!value?.paused) refuse();
  const now = current(value.m);
  const binding =
    require("./production-paused-draft-binding.cjs").readDraftBinding(
      value.authority,
    );
  const scope = require("./production-paused-drafts.cjs").readPausedReaderScope(
    cohortToken,
  );
  if (
    binding.purpose !== scope.purpose ||
    binding.actor !== scope.actor ||
    binding.manifestHash !== scope.manifestHash ||
    (principalPurpose && principalPurpose !== binding.purpose) ||
    pausedIdentity(scope) !== value.paused.identity ||
    now >= scope.validUntil
  )
    refuse();
  const principal = value.paused.principals.find(
    (p) => p.purpose === binding.purpose,
  );
  if (!principal) refuse();
  const receipt = {
    manifestHash: scope.manifestHash,
    purpose: binding.purpose,
    actor: binding.actor,
    principal,
    cohortHash: canonicalHash(scope.identities),
    captureHash: scope.declaration.capture.sha256,
    declarationHash: canonicalHash(scope.declaration),
    launcherBaselineHash: value.observation.baselineHash,
    observedAt: value.observation.observedAt,
    validUntil: Math.min(value.m.validUntil, scope.validUntil),
  };
  return { ...receipt, scopeSha256: value.paused.scopeSha256 };
}
module.exports = {
  collectLauncherSettingsFromOriginalRun,
  readLauncherSettings,
  readPausedEffectivePolicyScope,
};
