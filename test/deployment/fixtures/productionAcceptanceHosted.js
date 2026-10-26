import {
  protectedEnvironment as environment,
  protectedPolicy,
} from "../../fixtures/productionProviderFixtures.js";
import { Buffer } from "node:buffer";
import { launcherFixture } from "../../fixtures/productionLauncher.js";
import { canonicalHash } from "../../../scripts/deployment/production-manifest.cjs";
import { packageIntentHash } from "../../../scripts/deployment/production-package.cjs";
import { frozenFixtureDefinitions } from "../../../scripts/deployment/production-fixture-definitions.cjs";
export function hostedAcceptance(m) {
  m.identity.sessionName = `introduction-${m.identity.runId}-1`;
  const routes = m.launcherRoutes;
  const launcher = launcherFixture(m);
  m.launcherRoutes = routes;
  launcher.declaration.routes = launcher.declaration.routes.map((r, index) => ({
    ...r,
    ...routes[index],
  }));
  const branches = [{ name: "master", type: "branch" }];
  const policy = (name) => protectedPolicy(name, branches);
  m.acceptance.gatePolicy = {
    ...policy("production-acceptance"),
    environmentId: "3",
  };
  const evidence = Object.fromEntries(
    Object.keys(m.prerequisites).map((name) => [name, { fixture: name }]),
  );
  evidence.launcherHolds = launcher.declaration;
  evidence.fixtureChecklist = frozenFixtureDefinitions();
  evidence.retainedDisposition = {
    schemaVersion: 1,
    predicate: "missing-owner-or-version-v1",
    sourceCommit: m.identity.sourceCommit,
    records: [],
  };
  evidence.sourceTests = {
    schemaVersion: 1,
    sourceCommit: m.identity.sourceCommit,
    runId: "9",
    runAttempt: "1",
  };
  evidence.executionApproval = {
    ...policy("production"),
    continuationGate: {
      ...policy("production-continuation"),
      jobName: "Approve failed-unserved continuation",
    },
  };
  for (const [name, value] of Object.entries(evidence))
    m.prerequisites[name] = canonicalHash(value);
  const original = structuredClone(m);
  for (const key of ["runId", "runAttempt", "sessionName"])
    original.identity[key] = "$CURRENT";
  const pkg = {
    schemaVersion: 1,
    manifest: original,
    identitySlots: ["runId", "runAttempt", "sessionName"],
    repositoryId: "1",
    repositoryOwnerId: "2",
  };
  const env = {
    GITHUB_REPOSITORY: m.identity.repository,
    GITHUB_REF: m.identity.ref,
    GITHUB_SHA: m.identity.sourceCommit,
    GITHUB_WORKFLOW_REF: m.identity.workflow,
    GITHUB_RUN_ID: m.identity.runId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "introduce",
    INTRODUCTION_PACKAGE_ID: "reviewed",
    INTRODUCTION_PACKAGE_COMMIT: "b".repeat(40),
    INTRODUCTION_OPS_READ_TOKEN: "dummy-private",
    GH_TOKEN: "dummy-github",
    AWS_ACCOUNT_ID: m.identity.accountId,
    AWS_REGION: m.identity.region,
    PRODUCTION_INTRODUCTION_ROLE_ARN: m.identity.roleArn,
    INTRODUCTION_INTENT_HASH: packageIntentHash(pkg),
  };
  const state = {
    mode: "introduce",
    repair: false,
    endedAt: 0,
    supplement: undefined,
  };
  const run = {
    id: Number(m.identity.runId),
    run_attempt: 1,
    head_sha: m.identity.sourceCommit,
    head_branch: "master",
    event: "workflow_dispatch",
    path: ".github/workflows/introduce-production.yml",
    repository: m.identity.repository,
    repositoryId: 1,
    repositoryOwnerId: 2,
  };
  function jobs() {
    const end = state.endedAt;
    const row = (name, start, finish, conclusion = "success", index = 0) => ({
      id: index + 1,
      name,
      head_sha: m.identity.sourceCommit,
      status: finish === null ? "in_progress" : "completed",
      conclusion: finish === null ? null : conclusion,
      started_at: new Date(start * 1000).toISOString(),
      completed_at:
        finish === null ? null : new Date(finish * 1000).toISOString(),
    });
    return [
      row(
        "Introduce production",
        100,
        state.repair ? 200 : end,
        state.repair ? "failure" : "success",
        0,
      ),
      row(
        "Approve failed-unserved continuation",
        201,
        202,
        state.repair ? "success" : "skipped",
        1,
      ),
      row(
        "Continue failed-unserved introduction",
        203,
        end,
        state.repair ? "success" : "skipped",
        2,
      ),
      row("Prepare production acceptance", end + 1, end + 2, "success", 3),
      row("Approve production acceptance", end + 3, end + 4, "success", 4),
      row("Accept production introduction", end + 5, null, null, 5),
    ];
  }
  function privateFile(endpoint) {
    const path = endpoint.split("/contents/")[1].split("?")[0],
      name = path.split("/").at(-1).replace(".json", "");
    const value =
      name === "execution"
        ? pkg
        : name === "acceptance"
          ? state.supplement
          : evidence[name];
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      type: "file",
      path,
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
    };
  }
  async function github(endpoint, query) {
    if (endpoint.includes("chronote-ops/contents/"))
      return privateFile(endpoint);
    if (endpoint.endsWith("/actions/runs/9"))
      return {
        ...run,
        conclusion: "success",
        path: ".github/workflows/ci.yml",
      };
    if (endpoint.includes("/runs/9/attempts"))
      return {
        total_count: 2,
        jobs: ["Unit Tests", "Deployment Integration"].map((name) => ({
          name,
          conclusion: "success",
          head_sha: m.identity.sourceCommit,
        })),
      };
    if (endpoint.endsWith(`/actions/runs/${m.identity.runId}`)) return run;
    if (endpoint.endsWith("/approvals"))
      return [
        {
          state: "approved",
          environments: [
            "production",
            "production-continuation",
            "production-acceptance",
          ].map((name) => ({ id: environment(name).id, name })),
          userId: 7,
        },
      ];
    if (
      endpoint.includes("/deployment-branch-policies") &&
      !query.includes("items:")
    )
      return branches;
    if (/\/environments\/[^/?]+$/.test(endpoint))
      return environment(endpoint.split("/").at(-1));
    if (endpoint.includes("/attempts/1/jobs")) {
      const rows =
        state.mode === "introduce"
          ? [
              {
                id: 1,
                name: "Introduce production",
                head_sha: m.identity.sourceCommit,
                status: "in_progress",
                conclusion: null,
              },
            ]
          : jobs();
      return query.includes("items:")
        ? { total_count: rows.length, items: rows }
        : { total_count: rows.length, jobs: rows };
    }
    return launcher.github(endpoint);
  }
  return { env, state, evidence, launcher, github };
}
