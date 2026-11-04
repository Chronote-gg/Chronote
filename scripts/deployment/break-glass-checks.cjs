"use strict";
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
/**
 * Jobs a break-glass deploy relies on instead of re-running CI. A rename in
 * CI makes the gate refuse rather than pass on a missing check.
 */
const REQUIRED_CHECKS = [
  "Core CI / Build",
  "Core CI / Unit Tests",
  "Core CI / Deployment Integration",
  "Core CI / Docker Build",
  "Code quality ratchet",
];
const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const MAX_CONTEXTS = 100;
const QUERY = `query($owner: String!, $name: String!, $sha: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        associatedPullRequests(first: 5) {
          nodes {
            number
            merged
            baseRefName
            headRefOid
            mergeCommit { oid }
            commits(last: 1) {
              nodes {
                commit {
                  oid
                  statusCheckRollup {
                    contexts(first: ${MAX_CONTEXTS}) {
                      totalCount
                      nodes {
                        __typename
                        ... on CheckRun {
                          name
                          status
                          conclusion
                          databaseId
                          checkSuite {
                            app { slug }
                            workflowRun { workflow { name } }
                          }
                        }
                        ... on StatusContext { context state }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;
function refuse(message) {
  throw new CoordinatorFailure("pull_request_checks_unverified", message);
}
/** The one merged master pull request whose merge produced exactly this commit. */
function mergedPullRequest(commit, sha) {
  const merged = (commit?.associatedPullRequests?.nodes ?? []).filter(
    (pr) =>
      pr.merged && pr.baseRefName === "master" && pr.mergeCommit?.oid === sha,
  );
  if (merged.length !== 1)
    refuse("The commit is not the merge commit of one master pull request");
  return merged[0];
}
const suiteOf = (run) =>
  run.checkSuite?.workflowRun?.workflow?.name ??
  run.checkSuite?.app?.slug ??
  "";
/** A re-run supersedes its earlier attempt; the highest id per check wins. */
function latestCheckRuns(contexts) {
  const latest = new Map();
  for (const run of contexts.filter((c) => c.__typename === "CheckRun")) {
    const key = `${suiteOf(run)}\n${run.name}`;
    if (!latest.has(key) || latest.get(key).databaseId < run.databaseId)
      latest.set(key, run);
  }
  return [...latest.values()];
}
function contextsOf(pr) {
  const head = pr.commits?.nodes?.[0]?.commit;
  if (!head || head.oid !== pr.headRefOid)
    refuse("The pull request head commit is unavailable");
  const contexts = head.statusCheckRollup?.contexts;
  if (!contexts || contexts.totalCount > contexts.nodes.length)
    refuse("The pull request check list is missing or incomplete");
  return contexts.nodes;
}
function assertGreen(runs, statuses) {
  const red = runs.filter(
    (run) => run.status !== "COMPLETED" || !GREEN.has(run.conclusion),
  );
  if (red.length || statuses.some((status) => status.state !== "SUCCESS"))
    refuse(
      `Pull request checks are not green: ${red.map((run) => run.name).join(", ") || "commit status"}`,
    );
  const missing = REQUIRED_CHECKS.filter(
    (name) =>
      !runs.some((run) => run.name === name && run.conclusion === "SUCCESS"),
  );
  if (missing.length)
    refuse(`Required pull request checks did not pass: ${missing.join(", ")}`);
}
/**
 * Pure verdict over one GraphQL response: the commit is the merge of a master
 * pull request whose latest CI on its head is green, required jobs included.
 */
function evaluateMergedChecks(commit, sha) {
  const pr = mergedPullRequest(commit, sha);
  const contexts = contextsOf(pr);
  const runs = latestCheckRuns(contexts);
  assertGreen(
    runs,
    contexts.filter((c) => c.__typename === "StatusContext"),
  );
  return {
    pullRequest: pr.number,
    headSha: pr.headRefOid,
    checkRuns: runs.length,
  };
}
async function verifyMergedChecks(env, request) {
  const [owner, name] = (env.GITHUB_REPOSITORY ?? "").split("/");
  const sha = env.GITHUB_SHA ?? "";
  if (!owner || !name || !/^[a-f0-9]{40}$/.test(sha) || !env.GITHUB_TOKEN)
    refuse("Repository, commit and token are required for the check gate");
  const response = await request(
    `${env.GITHUB_API_URL ?? "https://api.github.com"}/graphql`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: QUERY, variables: { owner, name, sha } }),
    },
  );
  const body = response.ok ? await response.json() : undefined;
  if (!body || body.errors?.length)
    refuse("GitHub did not answer the pull request check query");
  return evaluateMergedChecks(body.data?.repository?.object, sha);
}
module.exports = {
  REQUIRED_CHECKS,
  evaluateMergedChecks,
  verifyMergedChecks,
};
