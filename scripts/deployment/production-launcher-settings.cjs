"use strict";
const { isDeepStrictEqual: same } = require("node:util");
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
  await readIamSettings(readers.aws, declaration);
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
  const token = Object.freeze({});
  receipts.set(token, { m, observation });
  return token;
}
function readLauncherSettings(token, binding) {
  const value = receipts.get(token);
  if (!value || (binding && !same(value.m, binding.manifest))) refuse();
  current(value.m);
  return structuredClone(value.observation);
}
module.exports = {
  collectLauncherSettingsFromOriginalRun,
  readLauncherSettings,
};
