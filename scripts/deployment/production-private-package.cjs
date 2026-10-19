"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { z } = require("zod");
const { materializePackage } = require("./production-package.cjs");
const { canonicalHash } = require("./production-manifest.cjs");
const exec = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{40}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const packageId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const product = "Chronote-gg/Chronote",
  operations = "Chronote-gg/chronote-ops";
function refuse() {
  throw new Error("private_package_prerequisite");
}
async function githubJson(endpoint, query, token) {
  if (!token) refuse();
  try {
    const result = await exec("gh", ["api", endpoint, "--jq", query], {
      env: { ...process.env, GH_TOKEN: token },
      maxBuffer: 1024 * 1024,
      timeout: 30000,
    });
    return JSON.parse(result.stdout);
  } catch {
    return refuse();
  }
}
async function privateFile(env, name) {
  const commit = sha.parse(env.INTRODUCTION_PACKAGE_COMMIT),
    id = packageId.parse(env.INTRODUCTION_PACKAGE_ID);
  if (
    ![
      "execution.json",
      "executionApproval.json",
      "sourceTests.json",
      "retainedDisposition.json",
      "launcherHolds.json",
      "fixtureChecklist.json",
      "plan.json",
    ].includes(name)
  )
    refuse();
  const path = `production-introductions/${id}/${name}`;
  const item = await githubJson(
    `repos/${operations}/contents/${path}?ref=${commit}`,
    "{type,path,encoding,size,content}",
    env.INTRODUCTION_OPS_READ_TOKEN,
  );
  if (
    item.type !== "file" ||
    item.path !== path ||
    item.encoding !== "base64" ||
    item.size > 262144
  )
    refuse();
  const bytes = Buffer.from(item.content, "base64");
  if (bytes.length !== item.size) refuse();
  return JSON.parse(bytes.toString("utf8"));
}
function assertRunContext(env, run) {
  if (
    env.GITHUB_REPOSITORY !== product ||
    env.GITHUB_REF !== "refs/heads/master" ||
    env.GITHUB_WORKFLOW_REF !==
      `${product}/.github/workflows/introduce-production.yml@refs/heads/master` ||
    String(run.id) !== env.GITHUB_RUN_ID ||
    String(run.run_attempt) !== env.GITHUB_RUN_ATTEMPT ||
    run.head_sha !== env.GITHUB_SHA ||
    run.head_branch !== "master" ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/introduce-production.yml" ||
    run.repository !== product
  )
    refuse();
}
function assertEnvironmentPolicy(environment, branches, policy, name) {
  if (
    environment.name !== name ||
    String(environment.id) !== String(policy.environmentId) ||
    canonicalHash(environment) !== policy.environmentHash ||
    canonicalHash(branches) !== policy.branchPolicyHash ||
    !environment.deployment_branch_policy?.custom_branch_policies ||
    branches.length !== 1 ||
    branches[0].name !== "master" ||
    branches[0].type !== "branch" ||
    environment.can_admins_bypass !== false ||
    !environment.protection_rules.some(
      (r) =>
        r.type === "required_reviewers" &&
        r.prevent_self_review === true &&
        r.reviewers.length,
    )
  )
    refuse();
}
function assertHostedContext({
  env,
  run,
  environment,
  branches,
  approvals,
  approvalPolicy,
  environmentName = "production",
}) {
  assertRunContext(env, run);
  assertEnvironmentPolicy(
    environment,
    branches,
    approvalPolicy,
    environmentName,
  );
  if (
    !approvals.some(
      (a) =>
        a.state === "approved" &&
        a.environments.some(
          (e) => e.id === environment.id && e.name === environmentName,
        ) &&
        approvalPolicy.reviewerIds.includes(String(a.userId)),
    )
  )
    refuse();
}
async function readEnvironment(name, token) {
  const base = `repos/${product}/environments/${name}`;
  const environment = await githubJson(
    base,
    "{id,name,can_admins_bypass,protection_rules:[.protection_rules[]|{type,prevent_self_review,reviewers:[.reviewers[]?|{type,id:.reviewer.id}]}],deployment_branch_policy}",
    token,
  );
  const branches = await githubJson(
    `${base}/deployment-branch-policies?per_page=100`,
    "[.branch_policies[]|{name,type}]",
    token,
  );
  return { environment, branches };
}
function assertContinuationJobs(jobs, source) {
  if (jobs.total_count !== jobs.jobs.length) refuse();
  const select = (name) => {
    const matches = jobs.jobs.filter((j) => j.name === name);
    if (matches.length !== 1 || matches[0].head_sha !== source) refuse();
    return matches[0];
  };
  const initial = select("Introduce production"),
    gate = select("Approve failed-unserved continuation"),
    current = select("Continue failed-unserved introduction");
  const at = (value) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) refuse();
    return time;
  };
  if (
    initial.conclusion !== "failure" ||
    initial.status !== "completed" ||
    gate.conclusion !== "success" ||
    gate.status !== "completed" ||
    current.status !== "in_progress" ||
    current.conclusion !== null ||
    at(gate.started_at) < at(initial.completed_at) ||
    at(current.started_at) < at(gate.completed_at) ||
    at(gate.completed_at) < at(gate.started_at)
  )
    refuse();
}
async function loadProductionPackage(env, aws, mode = "introduce") {
  if (
    !["introduce", "continue"].includes(mode) ||
    env.GITHUB_JOB !== (mode === "introduce" ? "introduce" : "continue")
  )
    refuse();
  digest.parse(env.INTRODUCTION_INTENT_HASH);
  if (
    !env.PRODUCTION_INTRODUCTION_ROLE_ARN ||
    !env.AWS_REGION ||
    !env.AWS_ACCOUNT_ID ||
    Object.keys(env).some(
      (key) => key.startsWith("AWS_ENDPOINT_URL") && env[key],
    )
  )
    refuse();
  const input = await privateFile(env, "execution.json");
  const evidence = {};
  for (const name of Object.keys(input.manifest.prerequisites)) {
    evidence[name] = await privateFile(env, `${name}.json`);
    if (canonicalHash(evidence[name]) !== input.manifest.prerequisites[name])
      refuse();
  }
  const base = `repos/${product}`;
  const run = await githubJson(
    `${base}/actions/runs/${env.GITHUB_RUN_ID}`,
    "{id,run_attempt,head_sha,head_branch,event,path,repository:.repository.full_name,repositoryId:.repository.id,repositoryOwnerId:.repository.owner.id}",
    env.GH_TOKEN,
  );
  const { environment, branches } = await readEnvironment(
    "production",
    env.GH_TOKEN,
  );
  const approvals = await githubJson(
    `${base}/actions/runs/${env.GITHUB_RUN_ID}/approvals`,
    "[.[]|{state,environments:[.environments[]|{id,name}],userId:.user.id}]",
    env.GH_TOKEN,
  );
  assertHostedContext({
    env,
    run,
    environment,
    branches,
    approvals,
    approvalPolicy: evidence.executionApproval,
  });
  const gateName = "production-continuation";
  if (
    evidence.executionApproval.continuationGate?.jobName !==
    "Approve failed-unserved continuation"
  )
    refuse();
  const { environment: gateEnvironment, branches: gateBranches } =
    await readEnvironment(gateName, env.GH_TOKEN);
  // Validate the future protected gate before any legacy stop.
  const gatePolicy = evidence.executionApproval.continuationGate;
  assertEnvironmentPolicy(gateEnvironment, gateBranches, gatePolicy, gateName);
  if (mode === "continue") {
    assertHostedContext({
      env,
      run,
      environment: gateEnvironment,
      branches: gateBranches,
      approvals,
      approvalPolicy: gatePolicy,
      environmentName: gateName,
    });
    const jobs = await githubJson(
      `${base}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
      "{total_count,jobs:[.jobs[]|{name,head_sha,status,conclusion,started_at,completed_at}]}",
      env.GH_TOKEN,
    );
    assertContinuationJobs(jobs, env.GITHUB_SHA);
  }
  const caller = await aws("sts", "get-caller-identity", {});
  const context = {
    accountId: env.AWS_ACCOUNT_ID,
    region: env.AWS_REGION,
    repository: env.GITHUB_REPOSITORY,
    githubEnvironment: "production",
    ref: env.GITHUB_REF,
    sourceCommit: env.GITHUB_SHA,
    workflow: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    roleArn: env.PRODUCTION_INTRODUCTION_ROLE_ARN,
    sessionName: `introduction-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    now: Math.floor(Date.now() / 1000),
    endpointOverrides: [],
    repositoryId: String(run.repositoryId),
    repositoryOwnerId: String(run.repositoryOwnerId),
  };
  return {
    ...materializePackage(input, env.INTRODUCTION_INTENT_HASH, context, {
      accountId: caller.Account,
      arn: caller.Arn,
    }),
    evidence,
  };
}
async function verifyOwnershipEvidence(binding, evidence, token) {
  const source = binding.manifest.identity.sourceCommit;
  const proof = evidence.sourceTests;
  if (
    proof.schemaVersion !== 1 ||
    proof.sourceCommit !== source ||
    !/^\d+$/.test(proof.runId) ||
    !/^\d+$/.test(proof.runAttempt)
  )
    refuse();
  const run = await githubJson(
    `repos/${product}/actions/runs/${proof.runId}`,
    "{head_sha,conclusion,run_attempt,repository:.repository.full_name,path}",
    token,
  );
  const jobs = await githubJson(
    `repos/${product}/actions/runs/${proof.runId}/attempts/${proof.runAttempt}/jobs?per_page=100`,
    "{total_count,jobs:[.jobs[]|{name,conclusion,head_sha}]}",
    token,
  );
  if (
    run.head_sha !== source ||
    run.conclusion !== "success" ||
    String(run.run_attempt) !== proof.runAttempt ||
    run.repository !== product ||
    ![".github/workflows/ci.yml", ".github/workflows/deploy.yml"].includes(
      run.path,
    ) ||
    jobs.total_count !== jobs.jobs.length ||
    !["Unit Tests", "Deployment Integration"].every((name) =>
      jobs.jobs.some(
        (job) =>
          (job.name === name || job.name.endsWith(` / ${name}`)) &&
          job.conclusion === "success" &&
          job.head_sha === source,
      ),
    )
  )
    refuse();
  // Future schedules additionally need provider-origin ACK receipts; this route never invents them.
  if (
    evidence.retainedDisposition.compatibleFuture?.records?.some(
      (r) => r.scheduleAcknowledgment,
    )
  )
    throw new Error("schedule_ack_provenance_prerequisite");
  return {
    consumerSourceCommit: source,
    ownershipEvidenceHash: canonicalHash(proof),
    reviewedDispositionHash: canonicalHash(evidence.retainedDisposition),
  };
}
module.exports = {
  assertContinuationJobs,
  privateFile,
  githubJson,
  assertHostedContext,
  loadProductionPackage,
  verifyOwnershipEvidence,
};
