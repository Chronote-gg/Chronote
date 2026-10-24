"use strict";
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  parseProductionManifest,
  parsePhaseAuthorization,
  phases,
} = require("./production-manifest.cjs");
const { manifestHash, awsCaller } = require("./sandbox-manifest.cjs");
const { createProductionIntroduction } = require("./introduce-production.cjs");
const {
  assertProductionIdentity,
} = require("./assert-production-identity.cjs");
function validateContext(options, context) {
  const m = parseProductionManifest(options.manifest, options.expectedSha256);
  assert.equal(context.ref, "refs/heads/master");
  assert.equal(context.repository, m.sourceRepository);
  assert.equal(context.sourceSha, m.binding.sourceSha);
  assert.equal(context.operationId, m.binding.operationId);
  assert.equal(context.accountId, m.binding.accountId);
  assert.equal(context.roleArn, m.deploymentRoleArn);
  assert.equal(
    context.runAttempt,
    "1",
    "Reruns cannot replace a bound proposal",
  );
  assert.match(context.runId, /^[1-9]\d{0,19}$/);
  assert.ok(phases.includes(context.phase));
  assert.ok(
    (options.now ?? (() => Date.now() / 1000))() < m.validUntil,
    "Manifest expired",
  );
  return m;
}
async function inspectCurrent(options, context) {
  const m = validateContext(options, context);
  const aws = options.aws ?? awsCaller(m.binding.region);
  const actor = await aws("sts", "get-caller-identity", {});
  assertProductionIdentity(actor, {
    EXPECTED_ACCOUNT_ID: m.binding.accountId,
    EXPECTED_ROLE_ARN: m.deploymentRoleArn,
    EXPECTED_SESSION_NAME: `chronote-production-${context.runId}-1`,
  });
  const inspection = await createProductionIntroduction({
    ...options,
    aws,
  }).run("inspect");
  return { m, actor, inspection };
}
async function bindProposal(options, context) {
  assert.notEqual(context.phase, "inspect");
  const { m, actor, inspection } = await inspectCurrent(options, context);
  const envelope = {
    kind: "production-phase",
    manifestSha256: options.expectedSha256,
    operationId: m.binding.operationId,
    phase: context.phase,
    runId: context.runId,
    runAttempt: 1,
    principalArn: actor.Arn,
    sourceSha: m.binding.sourceSha,
    predecessorSha256: inspection.head?.receiptSha256 ?? null,
    validUntil: m.validUntil,
    // Recovery needs reviewed private failure evidence, which is not delivered yet.
    recovery: null,
  };
  const sha256 = manifestHash(envelope);
  parsePhaseAuthorization(
    {
      envelope,
      expectedSha256: sha256,
      bindSha256: sha256,
      currentRunId: context.runId,
      currentRunAttempt: 1,
    },
    m,
    options.expectedSha256,
  );
  return { envelope, sha256, inspection };
}
async function executeProposal(options, context, approval) {
  const m = validateContext(options, context);
  assert.notEqual(context.phase, "inspect");
  const envelope = parsePhaseAuthorization(
    {
      ...approval,
      currentRunId: context.runId,
      currentRunAttempt: Number(context.runAttempt),
    },
    m,
    options.expectedSha256,
  );
  assert.equal(envelope.phase, context.phase);
  assert.ok(
    (options.now ?? (() => Date.now() / 1000))() < envelope.validUntil,
    "Approval expired",
  );
  const { inspection } = await inspectCurrent(options, context);
  assert.equal(
    envelope.predecessorSha256,
    inspection.head?.receiptSha256 ?? null,
    "Stale approved predecessor",
  );
  // Remove only after reviewed gate wiring and authorized exact-topology acceptance.
  throw new Error("Post-bind human authority unavailable; preserve state");
}
function workflowContext(env) {
  return {
    phase: env.INTRODUCTION_PHASE,
    operationId: env.INTRODUCTION_OPERATION_ID,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceSha: env.GITHUB_SHA,
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    accountId: env.EXPECTED_ACCOUNT_ID,
    roleArn: env.EXPECTED_ROLE_ARN,
  };
}
async function runCli(
  command = process.argv[2],
  env = process.env,
  output = console,
) {
  try {
    assert.ok(["inspect", "bind", "execute"].includes(command));
    const options = {
      manifest: JSON.parse(env.PRODUCTION_INTRODUCTION_MANIFEST),
      expectedSha256: env.INTRODUCTION_MANIFEST_SHA256,
    };
    const context = workflowContext(env);
    const directory = join(env.RUNNER_TEMP, "production-introduction");
    mkdirSync(directory, { mode: 0o700 });
    const save = (name, body) =>
      writeFileSync(join(directory, name), JSON.stringify(body), {
        mode: 0o600,
        flag: "wx",
      });
    save("manifest.json", options.manifest);
    if (command === "execute") {
      const approval = {
        envelope: JSON.parse(env.PRODUCTION_PHASE_ENVELOPE),
        expectedSha256: env.PRODUCTION_PHASE_EXPECTED_SHA256,
        bindSha256: env.BIND_SHA256,
      };
      save("approval.json", approval);
      await executeProposal(options, context, approval);
    } else if (command === "bind") {
      const proposal = await bindProposal(options, context);
      save("proposal.json", proposal.envelope);
      save("inspection.json", proposal.inspection);
      appendFileSync(env.GITHUB_OUTPUT, `sha256=${proposal.sha256}\n`);
      output.log(
        JSON.stringify({
          kind: "proposal_bound_execution_unavailable",
          sha256: proposal.sha256,
        }),
      );
    } else {
      assert.equal(context.phase, "inspect");
      const { inspection } = await inspectCurrent(options, context);
      save("inspection.json", inspection);
      output.log(
        JSON.stringify({
          kind: "inspection_complete",
          sha256: manifestHash(inspection),
        }),
      );
    }
    return 0;
  } catch {
    output.error(
      JSON.stringify({
        kind: "production_introduction_refused",
        action: "preserve_state_and_reconcile",
      }),
    );
    return 1;
  }
}
module.exports = { bindProposal, executeProposal, inspectCurrent, runCli };
if (require.main === module)
  runCli().then((code) => {
    process.exitCode = code;
  });
