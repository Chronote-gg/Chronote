/** @jest-environment node */
import { privateFileResponse } from "../fixtures/productionPrivateFile.js";
import {
  protectedEnvironment as environment,
  protectedPolicy,
} from "../fixtures/productionProviderFixtures.js";
import {
  createAcceptanceReadAws,
  createProductionAws,
} from "../../scripts/deployment/production-aws.cjs";
import { assertBoundExecution } from "../../scripts/deployment/production-manifest.cjs";
import { frozenFixtureDefinitions } from "../../scripts/deployment/production-fixture-definitions.cjs";
import { jest, afterEach, test, expect } from "@jest/globals";
import { Buffer } from "node:buffer";
import process from "node:process";
import { fixture } from "../fixtures/productionManifest.js";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import {
  acceptanceDeclaration,
  closingActions,
} from "../fixtures/productionAcceptance.js";
import { assertProductionPreflight } from "../../scripts/deployment/production-preflight.cjs";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { packageIntentHash } from "../../scripts/deployment/production-package.cjs";
import {
  loadProductionPackage,
  assertContinuationJobs,
  privateFile,
  loadAcceptancePackage,
  readCollectionBinding,
} from "../../scripts/deployment/production-private-package.cjs";
const mockGithub = jest.fn();
const mockAws = jest.fn();
jest.mock("../../scripts/deployment/coordinator-aws.cjs", () => ({
  awsCli: (...args) => mockAws(...args),
}));
jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  const execFile = () => undefined;
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) =>
    mockGithub(...args);
  return { ...actual, execFile };
});
afterEach(() => {
  jest.restoreAllMocks();
  mockGithub.mockReset();
  mockAws.mockReset();
});
function hostedFixture(manifest = fixture()) {
  manifest.validUntil = 15000;
  Object.assign(manifest.identity, {
    repository: "Chronote-gg/Chronote",
    ref: "refs/heads/master",
    workflow:
      "Chronote-gg/Chronote/.github/workflows/introduce-production.yml@refs/heads/master",
    runId: "$CURRENT",
    runAttempt: "$CURRENT",
    sessionName: "$CURRENT",
  });
  const env = {
    GITHUB_REPOSITORY: manifest.identity.repository,
    GITHUB_REF: manifest.identity.ref,
    GITHUB_SHA: manifest.identity.sourceCommit,
    GITHUB_WORKFLOW_REF: manifest.identity.workflow,
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "introduce",
    INTRODUCTION_PACKAGE_ID: "reviewed",
    INTRODUCTION_PACKAGE_COMMIT: "b".repeat(40),
    INTRODUCTION_OPS_READ_TOKEN: "dummy-private",
    GH_TOKEN: "dummy-github",
    AWS_ACCOUNT_ID: manifest.identity.accountId,
    AWS_REGION: manifest.identity.region,
    PRODUCTION_INTRODUCTION_ROLE_ARN: manifest.identity.roleArn,
  };
  const branches = [{ name: "master", type: "branch" }];
  const policy = (name) => protectedPolicy(name, branches);
  const evidence = Object.fromEntries(
    Object.keys(manifest.prerequisites).map((name) => [
      name,
      { fixture: name },
    ]),
  );
  evidence.fixtureChecklist = frozenFixtureDefinitions();
  evidence.executionApproval = {
    ...policy("production"),
    continuationGate: {
      ...policy("production-continuation"),
      jobName: "Approve failed-unserved continuation",
    },
  };
  manifest.acceptance = {
    ...acceptanceDeclaration(),
    gatePolicy: { ...policy("production-acceptance"), environmentId: "3" },
  };
  if (!manifest.actions.some((a) => a.kind === "acceptance_write"))
    manifest.actions.push(...closingActions());
  for (const name of Object.keys(evidence))
    manifest.prerequisites[name] = canonicalHash(evidence[name]);
  const pkg = {
    schemaVersion: 1,
    manifest,
    identitySlots: ["runId", "runAttempt", "sessionName"],
    repositoryId: "11",
    repositoryOwnerId: "22",
  };
  env.INTRODUCTION_INTENT_HASH = packageIntentHash(pkg);
  const run = {
    id: 10,
    run_attempt: 1,
    head_sha: env.GITHUB_SHA,
    head_branch: "master",
    event: "workflow_dispatch",
    path: ".github/workflows/introduce-production.yml",
    repository: env.GITHUB_REPOSITORY,
    repositoryId: 11,
    repositoryOwnerId: 22,
  };
  const approvals = [
    {
      state: "approved",
      environments: [
        { id: 1, name: "production" },
        { id: 2, name: "production-continuation" },
      ],
      userId: 7,
    },
  ];
  const jobs = {
    jobs: [
      {
        name: "Introduce production",
        head_sha: env.GITHUB_SHA,
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-01-01T00:00:01Z",
      },
      {
        name: "Approve failed-unserved continuation",
        head_sha: env.GITHUB_SHA,
        status: "completed",
        conclusion: "success",
        started_at: "2026-01-01T00:00:02Z",
        completed_at: "2026-01-01T00:00:03Z",
      },
      {
        name: "Continue failed-unserved introduction",
        head_sha: env.GITHUB_SHA,
        status: "in_progress",
        conclusion: null,
        started_at: "2026-01-01T00:00:04Z",
      },
    ],
    total_count: 3,
  };
  const calls = [];
  mockGithub.mockImplementation(async (_exe, args) => {
    const endpoint = args[1];
    calls.push(endpoint);
    let value;
    if (endpoint.startsWith("repos/Chronote-gg/chronote-ops/contents/")) {
      const path = endpoint.split("/contents/")[1].split("?")[0],
        name = path.split("/").at(-1).replace(".json", "");
      value = privateFileResponse(
        path,
        name === "execution" ? pkg : evidence[name],
      );
    } else if (endpoint.includes("deployment-branch-policies"))
      value = branches;
    else if (endpoint.includes("/environments/"))
      value = environment(endpoint.split("/").at(-1));
    else if (endpoint.endsWith("/approvals")) value = approvals;
    else if (endpoint.includes("/jobs?")) value = jobs;
    else value = run;
    return { stdout: JSON.stringify(value), stderr: "" };
  });
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const aws = jest.fn(async () => ({
    Account: manifest.identity.accountId,
    Arn: `arn:aws:sts::${manifest.identity.accountId}:assumed-role/deploy/introduction-10-1`,
  }));
  return { env, aws, calls, approvals, jobs, run, pkg, evidence };
}

test("preparation authenticates its distinct read-only identity without minting mutation binding", async () => {
  const f = hostedFixture();
  f.env.GITHUB_JOB = "prepare-acceptance";
  f.jobs.jobs[2].status = "completed";
  f.jobs.jobs[2].conclusion = "success";
  f.jobs.jobs[2].completed_at = "1970-01-01T00:02:04Z";
  f.jobs.jobs[0].started_at = "1970-01-01T00:01:40Z";
  f.jobs.jobs[0].completed_at = "1970-01-01T00:01:50Z";
  f.jobs.jobs[1].started_at = "1970-01-01T00:01:51Z";
  f.jobs.jobs[1].completed_at = "1970-01-01T00:01:52Z";
  f.jobs.jobs[2].started_at = "1970-01-01T00:01:53Z";
  f.jobs.jobs.push({
    name: "Prepare production acceptance",
    head_sha: f.env.GITHUB_SHA,
    status: "in_progress",
    conclusion: null,
    started_at: "1970-01-01T00:02:05Z",
    completed_at: null,
  });
  f.jobs.total_count++;
  jest.replaceProperty(process, "env", f.env);
  mockAws.mockResolvedValue({
    Account: f.env.AWS_ACCOUNT_ID,
    Arn: `arn:aws:sts::${f.env.AWS_ACCOUNT_ID}:assumed-role/acceptance-reader/introduction-read-10-1`,
  });
  const loaded = await loadAcceptancePackage();
  const collection = readCollectionBinding(loaded.collection);
  const reader = createAcceptanceReadAws(loaded.collection);
  expect(Object.keys(reader).sort()).toEqual([
    "aws",
    "pausedDraftMetadata",
    "read",
    "scan",
  ]);
  expect(collection.manifest.identity.roleArn).toBe(
    f.env.PRODUCTION_INTRODUCTION_ROLE_ARN,
  );
  expect(collection.actor).toContain("assumed-role/acceptance-reader/");
  expect(() =>
    readCollectionBinding(structuredClone(loaded.collection)),
  ).toThrow();
  expect(() => readCollectionBinding({})).toThrow();
  expect(() => assertBoundExecution(collection, 150)).toThrow();
  expect(() => createProductionAws(loaded.collection)).toThrow();
  mockAws.mockResolvedValue({
    Account: f.env.AWS_ACCOUNT_ID,
    Arn: `arn:aws:sts::${f.env.AWS_ACCOUNT_ID}:assumed-role/deploy/introduction-10-1`,
  });
  await expect(loadAcceptancePackage()).rejects.toThrow();
  jest.spyOn(Date, "now").mockReturnValue(15000000);
  expect(() => readCollectionBinding(loaded.collection)).toThrow();
});
test("private exact file route materializes same immutable hold identity in current continuation attempt", async () => {
  const f = hostedFixture(),
    initial = await loadProductionPackage(f.env, f.aws);
  f.env.GITHUB_JOB = "continue";
  const continuation = await loadProductionPackage(f.env, f.aws, "continue");
  expect(continuation.binding.manifestHash).toBe(initial.binding.manifestHash);
  expect(
    f.calls
      .filter((p) => p.includes("chronote-ops"))
      .every((p) => p.endsWith(`?ref=${f.env.INTRODUCTION_PACKAGE_COMMIT}`)),
  ).toBe(true);
  expect(f.calls).toContain(
    "repos/Chronote-gg/Chronote/actions/runs/10/attempts/1/jobs?per_page=100",
  );
});
test.each(["missing-role", "missing-approval", "wrong-job", "wrong-attempt"])(
  "%s refuses before AWS identity or any mutation",
  async (reason) => {
    const f = hostedFixture();
    if (reason === "missing-role")
      delete f.env.PRODUCTION_INTRODUCTION_ROLE_ARN;
    if (reason === "missing-approval") f.approvals.splice(0);
    if (reason === "wrong-job") f.env.GITHUB_JOB = "unknown";
    if (reason === "wrong-attempt") f.run.run_attempt = 2;
    await expect(loadProductionPackage(f.env, f.aws)).rejects.toThrow();
    expect(f.aws).not.toHaveBeenCalled();
  },
);
test.each(["duplicate", "stale", "chronology", "missing", "incomplete"])(
  "continuation refuses %s current-attempt job evidence",
  (reason) => {
    const f = hostedFixture();
    if (reason === "duplicate") f.jobs.jobs.push(f.jobs.jobs[1]);
    if (reason === "stale") f.jobs.jobs[1].head_sha = "b".repeat(40);
    if (reason === "chronology")
      f.jobs.jobs[1].started_at = "2026-01-01T00:00:00Z";
    if (reason === "missing") f.jobs.jobs.pop();
    if (reason === "incomplete") f.jobs.total_count = 101;
    expect(() => assertContinuationJobs(f.jobs, f.env.GITHUB_SHA)).toThrow();
  },
);
test("private route refuses path escape, oversized data and captured CLI stderr without exposing payload", async () => {
  const f = hostedFixture();
  await expect(privateFile(f.env, "../secret")).rejects.toThrow();
  expect(mockGithub).not.toHaveBeenCalled();
  mockGithub.mockResolvedValue({
    stdout: JSON.stringify({
      type: "file",
      path: "production-introductions/reviewed/execution.json",
      encoding: "base64",
      size: 262145,
      content: "",
    }),
    stderr: "private",
  });
  await expect(privateFile(f.env, "execution.json")).rejects.toThrow(
    "private_package_prerequisite",
  );
  mockGithub.mockRejectedValue(new Error("secret provider stderr"));
  await expect(privateFile(f.env, "execution.json")).rejects.toThrow(
    "private_package_prerequisite",
  );
});

import { runCli } from "../../scripts/deployment/introduce-production.cjs";
test("actual introduction CLI sanitizes malformed private payload and captures provider stderr", async () => {
  const f = hostedFixture();
  jest.replaceProperty(process, "env", f.env);
  const bytes = Buffer.from(
    JSON.stringify({
      manifest: { prerequisites: { "private-secret-input": "sensitive" } },
    }),
  );
  mockGithub.mockResolvedValue({
    stdout: JSON.stringify({
      type: "file",
      path: "production-introductions/reviewed/execution.json",
      encoding: "base64",
      size: bytes.length,
      content: bytes.toString("base64"),
    }),
    stderr: "provider-private-error",
  });
  const output = { log: jest.fn(), error: jest.fn() };
  expect(await runCli(["introduce"], output)).toBe(1);
  expect(output.log).not.toHaveBeenCalled();
  expect(output.error).toHaveBeenCalledWith(
    JSON.stringify({
      status: "refused",
      reason: "introduction_prerequisite_or_recovery_required",
      admission: "preserve",
      deployment: "preserve",
    }),
  );
  expect(JSON.stringify(output.error.mock.calls)).not.toMatch(
    /private-secret|sensitive|provider-private/,
  );
});

test("complete reviewed 200-action package fits pinned file bound and loads both branches", async () => {
  const f = hostedFixture(completeManifest());
  const bytes = Buffer.byteLength(JSON.stringify(f.pkg));
  expect(bytes).toBeLessThanOrEqual(262144);
  const initial = await loadProductionPackage(f.env, f.aws);
  expect(assertProductionPreflight(initial.binding).actions).toHaveLength(200);
  f.env.GITHUB_JOB = "continue";
  const continuation = await loadProductionPackage(f.env, f.aws, "continue");
  expect(continuation.binding.manifestHash).toBe(initial.binding.manifestHash);
});

test.each(["introduce", "continue"])(
  "%s refuses later attempt despite stale allowed approval and successful current gate",
  async (mode) => {
    const f = hostedFixture(completeManifest());
    f.env.GITHUB_JOB = mode;
    f.env.GITHUB_RUN_ATTEMPT = "2";
    f.run.run_attempt = 2;
    f.aws.mockResolvedValue({
      Account: f.pkg.manifest.identity.accountId,
      Arn: `arn:aws:sts::${f.pkg.manifest.identity.accountId}:assumed-role/deploy/introduction-10-2`,
    });
    await expect(loadProductionPackage(f.env, f.aws, mode)).rejects.toThrow();
    expect(f.aws).not.toHaveBeenCalled();
  },
);

test.each([null, false, {}, "verified"])(
  "original loading rejects malformed explicit paused declaration %p",
  async (pausedDesktopDrafts) => {
    const f = hostedFixture();
    f.evidence.retainedDisposition.pausedDesktopDrafts = pausedDesktopDrafts;
    f.pkg.manifest.prerequisites.retainedDisposition = canonicalHash(
      f.evidence.retainedDisposition,
    );
    f.env.INTRODUCTION_INTENT_HASH = packageIntentHash(f.pkg);
    await expect(loadProductionPackage(f.env, f.aws)).rejects.toThrow();
  },
);
