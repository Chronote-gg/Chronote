"use strict";
const { canonicalHash } = require("./production-manifest.cjs");
const { githubJson } = require("./production-private-package.cjs");
const { isDeepStrictEqual: same } = require("node:util");
const {
  refuse,
  variables,
  repositoryVariables,
} = require("./production-launcher-schema.cjs");
const product = "repos/Chronote-gg/Chronote";
function assertCountedPage(r, total) {
  if (
    !Number.isSafeInteger(r.total_count) ||
    r.total_count < 0 ||
    !Array.isArray(r.items) ||
    r.items.length > 100 ||
    (total !== undefined && r.total_count !== total)
  )
    refuse();
}
async function countedPages(endpoint, field, projection, token) {
  const all = [],
    ids = new Set();
  let total;
  for (let page = 1; page <= 1000; page++) {
    const r = await githubJson(
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      `{total_count,items:[.${field}[]|${projection}]}`,
      token,
    );
    assertCountedPage(r, total);
    total = r.total_count;
    for (const item of r.items) {
      const key = item.id ?? item.name;
      if (key === undefined || ids.has(key)) refuse();
      ids.add(key);
      all.push(item);
    }
    if (all.length === total) return all;
    if (all.length > total || r.items.length < 100) refuse();
  }
  return refuse();
}
async function effectiveRules(token) {
  const all = [],
    ids = new Set();
  for (let page = 1; page <= 1000; page++) {
    const r = await githubJson(
      `${product}/rules/branches/master?per_page=100&page=${page}`,
      "[.[]|{type,parameters,ruleset_id,ruleset_source_type,ruleset_source}]",
      token,
    );
    if (!Array.isArray(r) || r.length > 100) refuse();
    for (const item of r) {
      const key = canonicalHash(item);
      if (ids.has(key)) refuse();
      ids.add(key);
      all.push(item);
    }
    if (r.length < 100) return all;
  }
  return refuse();
}
async function activeRuns(m, token) {
  const runs = await countedPages(
    `${product}/actions/runs`,
    "workflow_runs",
    "{id,run_attempt,path,status,head_sha,head_branch}",
    token,
  );
  const active = runs.filter((r) => r.status !== "completed");
  if (
    active.length !== 1 ||
    String(active[0].id) !== m.identity.runId ||
    active[0].run_attempt !== 1 ||
    active[0].head_sha !== m.identity.sourceCommit ||
    active[0].path !== ".github/workflows/introduce-production.yml"
  )
    refuse();
  const jobs = await countedPages(
    `${product}/actions/runs/${m.identity.runId}/attempts/1/jobs`,
    "jobs",
    "{id,name,status,conclusion,head_sha}",
    token,
  );
  const allowed = [
    "Introduce production",
    "Approve failed-unserved continuation",
    "Continue failed-unserved introduction",
    "Prepare production acceptance",
    "Approve production acceptance",
    "Accept production introduction",
  ];
  if (
    !jobs.length ||
    jobs.some(
      (j) =>
        !allowed.includes(j.name) || j.head_sha !== m.identity.sourceCommit,
    ) ||
    new Set(jobs.map((j) => j.name)).size !== jobs.length
  )
    refuse();
}
async function assertVariables(endpoint, names, expected, token) {
  const observed = await countedPages(
    endpoint,
    "variables",
    "{name,value}",
    token,
  );
  for (const name of names)
    if (observed.find((value) => value.name === name)?.value !== expected[name])
      refuse();
}
async function assertGithubPolicies(declaration, token, environment, branches) {
  const classic = await githubJson(
    `${product}/branches/master/protection`,
    "{required_status_checks,enforce_admins,required_pull_request_reviews,restrictions,required_linear_history,allow_force_pushes,allow_deletions,block_creations,required_conversation_resolution,lock_branch,allow_fork_syncing}",
    token,
  );
  if (
    !classic ||
    !classic.enforce_admins ||
    !classic.required_status_checks ||
    !classic.required_pull_request_reviews
  )
    refuse();
  const actions = await githubJson(
    `${product}/actions/permissions`,
    "{enabled,allowed_actions,selected_actions_url}",
    token,
  );
  if (
    !actions.enabled ||
    !["all", "local_only", "selected"].includes(actions.allowed_actions)
  )
    refuse();
  const selected =
    actions.allowed_actions === "selected"
      ? await githubJson(
          `${product}/actions/permissions/selected-actions`,
          "{github_owned_allowed,verified_allowed,patterns_allowed}",
          token,
        )
      : null;
  const hashes = {
    environmentHash: canonicalHash(environment),
    branchPolicyHash: canonicalHash(
      branches.map(({ name, type }) => ({ name, type })),
    ),
    classicProtectionHash: canonicalHash(classic),
    effectiveRulesHash: canonicalHash(await effectiveRules(token)),
    actionsPolicyHash: canonicalHash({ actions, selected }),
  };
  if (
    Object.entries(hashes).some(
      ([key, value]) => declaration.github[key] !== value,
    )
  )
    refuse();
}
async function readGithubSettings(m, declaration, token) {
  const repository = await githubJson(
    product,
    "{id,ownerId:.owner.id,full_name}",
    token,
  );
  if (
    String(repository.id) !== declaration.scope.repositoryId ||
    String(repository.ownerId) !== declaration.scope.repositoryOwnerId ||
    repository.full_name !== m.identity.repository
  )
    refuse();
  const ref = await githubJson(
    `${product}/git/ref/heads/master`,
    "{ref,object:{type:.object.type,sha:.object.sha}}",
    token,
  );
  if (
    !same(ref, {
      ref: m.identity.ref,
      object: { type: "commit", sha: m.identity.sourceCommit },
    })
  )
    refuse();
  for (const route of declaration.routes.slice(0, 2)) {
    const actual = await githubJson(
      `${product}/actions/workflows/${encodeURIComponent(route.path.split("/").at(-1))}`,
      "{id,path,state}",
      token,
    );
    if (
      !same(actual, {
        id: route.workflowId,
        path: route.path,
        state: route.state,
      })
    )
      refuse();
  }
  const environment = await githubJson(
    `${product}/environments/production`,
    "{id,name,can_admins_bypass,protection_rules:[.protection_rules[]|{type,prevent_self_review,reviewers:[.reviewers[]?|{type,id:.reviewer.id}]}],deployment_branch_policy}",
    token,
  );
  if (
    declaration.routes
      .slice(0, 2)
      .some((r) => String(environment.id) !== r.environmentId)
  )
    refuse();
  const branches = await countedPages(
    `${product}/environments/production/deployment-branch-policies`,
    "branch_policies",
    "{id,name,type}",
    token,
  );
  if (
    branches.length !== 1 ||
    branches[0].name !== "master" ||
    branches[0].type !== "branch"
  )
    refuse();
  await assertVariables(
    `${product}/environments/production/variables`,
    variables,
    declaration.github.variables,
    token,
  );
  await assertVariables(
    `${product}/actions/variables`,
    repositoryVariables,
    declaration.github.repositoryVariables,
    token,
  );
  // A successful, positively present classic protection response is required. 404 is never absence.
  await assertGithubPolicies(declaration, token, environment, branches);
  await activeRuns(m, token);
}
module.exports = { readGithubSettings };
