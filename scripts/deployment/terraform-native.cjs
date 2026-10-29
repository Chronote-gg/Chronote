"use strict";
const assert = require("node:assert/strict");
const { boundedBody } = require("./collector-principal.cjs");
function nativeGitHub(token, request = fetch) {
  assert.ok(typeof token === "string" && token.length > 0);
  return async (path, { paginated = false } = {}) => {
    try {
      assert.match(
        path,
        /^\/repos\/Chronote-gg\/Chronote\/[a-zA-Z0-9/_.?=-]+$/,
      );
      const signal = AbortSignal.timeout(30000);
      const response = await request("https://api.github.com" + path, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      assert.ok(response.ok);
      // Only callers that read a complete first page may accept more pages.
      if (!paginated) assert.equal(response.headers.get("link"), null);
      return JSON.parse(await boundedBody(response.body, 1048576, signal));
    } catch {
      throw new Error("UNKNOWN: GitHub metadata unavailable");
    }
  };
}
function runTitle(invocation, inputs) {
  require("./terraform-bundle.cjs").parseInvocation(invocation);
  const target = `${invocation.environment}/${invocation.workspace}/${invocation.scope}`;
  if (invocation.workflowPath.endsWith("terraform-plan.yml"))
    return `Terraform Plan ${target}`;
  assert.match(inputs.producerRunId, /^[1-9]\d{0,15}$/);
  assert.match(inputs.planSha256, /^[a-f0-9]{64}$/);
  assert.match(inputs.bundleSha256, /^[a-f0-9]{64}$/);
  return `Terraform Apply ${target} plan=${inputs.producerRunId} plan-sha=${inputs.planSha256} bundle-sha=${inputs.bundleSha256}`;
}
async function verifyRun(get, invocation, completed, inputs) {
  const run = await get(
    `/repos/${invocation.repository}/actions/runs/${invocation.runId}`,
  );
  assert.equal(String(run.id), invocation.runId);
  assert.equal(run.display_title, runTitle(invocation, inputs));
  assert.equal(run.repository.full_name, invocation.repository);
  assert.equal(run.head_repository.full_name, invocation.repository);
  assert.equal(run.head_sha, invocation.sourceSha);
  assert.equal(run.path.split("@")[0], invocation.workflowPath);
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.run_attempt, 1);
  assert.equal(invocation.runAttempt, 1);
  assert.equal(run.status, completed ? "completed" : "in_progress");
  assert.equal(run.conclusion, completed ? "success" : null);
  assert.ok(Number.isFinite(Date.parse(run.created_at)));
  return run;
}
// Inputs that shape what Terraform plans or how the saved plan is restored.
const terraformInputs = [
  /^_infra\//,
  /^scripts\/deployment\//,
  /^patches\//,
  /^\.yarn\//,
  /^\.github\/workflows\/terraform-(plan|apply)\.yml$/,
  /^(package\.json|yarn\.lock|\.nvmrc|\.node-version|\.npmrc|\.yarnrc|\.yarnrc\.yml)$/,
  /^scripts\/ci-install-dependencies\.sh$/,
];
// GitHub lists at most this many changed files, all on the first page.
const compareFileLimit = 300;
// Apply may run on a later master commit only if no Terraform input changed.
async function verifyApplySource(get, repository, planSha, applySha) {
  if (planSha === applySha) return "identical";
  let comparison;
  try {
    comparison = await get(
      `/repos/${repository}/compare/${planSha}...${applySha}?per_page=1`,
      { paginated: true },
    );
  } catch {
    throw new Error("UNKNOWN: plan and Apply source comparison unavailable");
  }
  assert.equal(
    comparison.status,
    "ahead",
    "Apply source must descend from the reviewed plan source",
  );
  assert.equal(comparison.merge_base_commit.sha, planSha);
  assert.ok(
    comparison.files.length < compareFileLimit,
    "Too many changed files to prove Terraform inputs unchanged",
  );
  const changed = comparison.files
    .flatMap((file) => [file.filename, file.previous_filename])
    .find((path) => path && terraformInputs.some((input) => input.test(path)));
  assert.equal(
    changed,
    undefined,
    `Terraform input changed since the reviewed plan: ${changed}`,
  );
  return "ahead";
}
function checkProtection(environment, invocation, run) {
  assert.equal(environment.name, invocation.environment);
  assert.ok(Number.isSafeInteger(environment.id) && environment.id > 0);
  // Native JSON mapping is pinned in docs/terraform-private-delivery.md; omission never means false.
  assert.equal(environment.can_admins_bypass, false);
  assert.ok(Date.parse(environment.updated_at) < Date.parse(run.created_at));
  assert.deepEqual(
    environment.protection_rules.map((rule) => rule.type).sort(),
    invocation.environment === "production"
      ? ["branch_policy", "required_reviewers"]
      : ["required_reviewers"],
  );
  const rule = environment.protection_rules.find(
    (rule) => rule.type === "required_reviewers",
  );
  assert.equal(rule.type, "required_reviewers");
  assert.equal(typeof rule.prevent_self_review, "boolean");
  assert.equal(rule.reviewers.length, 1);
  const reviewer = rule.reviewers[0];
  assert.equal(reviewer.type, "User");
  assert.equal(reviewer.reviewer.type, "User");
  assert.ok(
    Number.isSafeInteger(reviewer.reviewer.id) && reviewer.reviewer.id > 0,
  );
  return rule;
}
async function branchPolicyProof(get, environment, invocation, run) {
  if (invocation.environment !== "production") {
    assert.equal(environment.deployment_branch_policy, null);
    return null;
  }
  assert.deepEqual(environment.deployment_branch_policy, {
    protected_branches: false,
    custom_branch_policies: true,
  });
  assert.equal(run.head_branch, "master");
  const proof = await get(
    `/repos/${invocation.repository}/environments/${invocation.environment}/deployment-branch-policies?per_page=100`,
  );
  assert.equal(proof.total_count, 1);
  assert.equal(proof.branch_policies.length, 1);
  const policy = proof.branch_policies[0];
  assert.ok(Number.isSafeInteger(policy.id) && policy.id > 0);
  assert.equal(policy.name, "master");
  assert.equal(policy.type, "branch");
  return proof;
}
async function verifyApproval(get, invocation, inputs) {
  const run = await verifyRun(get, invocation, false, inputs);
  return verifyEnvironmentApproval(get, invocation, run);
}
async function verifyEnvironmentApproval(get, invocation, run) {
  const environment = await get(
    `/repos/${invocation.repository}/environments/${invocation.environment}`,
  );
  const reviewRule = checkProtection(environment, invocation, run);
  const reviewerId = reviewRule.reviewers[0].reviewer.id;
  const branchPolicies = await branchPolicyProof(
    get,
    environment,
    invocation,
    run,
  );
  const customRules = await get(
    `/repos/${invocation.repository}/environments/${invocation.environment}/deployment_protection_rules`,
  );
  assert.equal(customRules.total_count, 0);
  assert.deepEqual(customRules.custom_deployment_protection_rules, []);
  for (const actor of [run.actor, run.triggering_actor])
    assert.ok(Number.isSafeInteger(actor.id) && actor.id > 0);
  const reviews = await get(
    `/repos/${invocation.repository}/actions/runs/${invocation.runId}/approvals`,
  );
  assert.equal(reviews.length, 1);
  const review = reviews[0];
  assert.equal(review.state, "approved");
  assert.equal(review.user.type, "User");
  assert.equal(review.user.id, reviewerId);
  if (reviewRule.prevent_self_review) {
    assert.notEqual(review.user.id, run.actor.id);
    assert.notEqual(review.user.id, run.triggering_actor.id);
  }
  assert.equal(review.environments.length, 1);
  assert.equal(review.environments[0].id, environment.id);
  assert.equal(review.environments[0].name, invocation.environment);
  return {
    environment,
    branchPolicies,
    customRules,
    review,
    createdAt: run.created_at,
  };
}
module.exports = {
  nativeGitHub,
  verifyRun,
  verifyApplySource,
  verifyApproval,
  runTitle,
  verifyEnvironmentApproval,
};
