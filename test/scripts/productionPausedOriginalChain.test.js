/** @jest-environment node */
import { privateFileResponse } from "../fixtures/productionPrivateFile.js";
import { expect, test, jest, afterEach } from "@jest/globals";
import process from "node:process";
import { readFileSync as mockFile } from "node:fs";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import {
  launcherFixture,
  bindPreservationPolicies,
} from "../fixtures/productionLauncher.js";
import { pausedPreparationFixture } from "../fixtures/productionPausedPreparation.js";
import {
  protectedEnvironment,
  protectedPolicy,
} from "../fixtures/productionProviderFixtures.js";
import {
  reviewedRoutes,
  readOidcOnlySource,
} from "../fixtures/productionReviewedSource.js";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { packageIntentHash } from "../../scripts/deployment/production-package.cjs";
import { frozenFixtureDefinitions } from "../../scripts/deployment/production-fixture-definitions.cjs";
import { prepareOriginalPausedDrafts } from "../../scripts/deployment/production-paused-preparation.cjs";
import {
  loadProductionPackage,
  loadAcceptancePackage,
  readCollectionBinding,
} from "../../scripts/deployment/production-private-package.cjs";
import {
  bindOriginalPausedDisposition,
  collectPausedDraftMetadata,
  readPausedCohort,
  readPausedReaderScope,
} from "../../scripts/deployment/production-paused-drafts.cjs";
import {
  createProductionAws,
  createAcceptanceReadAws,
} from "../../scripts/deployment/production-aws.cjs";
import {
  collectLauncherSettingsFromOriginalRun,
  readPausedEffectivePolicyScope,
} from "../../scripts/deployment/production-launcher-settings.cjs";

const mockExec = jest.fn(),
  mockAws = jest.fn(),
  mockS3 = jest.fn(),
  mockDynamo = jest.fn();
jest.mock("../../scripts/deployment/coordinator-aws.cjs", () => ({
  awsCli: (...args) => mockAws(...args),
}));
jest.mock("node:child_process", () =>
  jest
    .requireActual("../fixtures/productionProcessMock.js")
    .reviewedProcessModuleMock((...args) => mockExec(...args)),
);

jest.mock("node:fs", () => {
  const actual = jest.requireActual("node:fs");
  return { ...actual, readFileSync: jest.fn(actual.readFileSync) };
});
jest.mock("@aws-sdk/client-s3", () =>
  jest
    .requireActual("../fixtures/productionSdkMock.js")
    .singleAttemptS3ModuleMock((...args) => mockS3(...args)),
);
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: (...args) => mockDynamo(...args) })),
}));
const savedEnv = process.env;
afterEach(() => {
  process.env = savedEnv;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
// Match Node's same-realm JSON evidence cloning while Jest isolates test objects.
function cloneInTestRealm(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneInTestRealm);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneInTestRealm(item)]),
  );
}
function originalEnvironment(m) {
  return {
    GITHUB_REPOSITORY: m.identity.repository,
    GITHUB_REF: m.identity.ref,
    GITHUB_SHA: m.identity.sourceCommit,
    GITHUB_WORKFLOW_REF: m.identity.workflow,
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "introduce",
    INTRODUCTION_PACKAGE_ID: "reviewed",
    INTRODUCTION_PACKAGE_COMMIT: "b".repeat(40),
    INTRODUCTION_OPS_READ_TOKEN: "synthetic-ops",
    GH_TOKEN: "synthetic-github",
    AWS_ACCOUNT_ID: m.identity.accountId,
    AWS_REGION: m.identity.region,
    PRODUCTION_INTRODUCTION_ROLE_ARN: m.identity.roleArn,
  };
}
function wireGithub(m, launcher, prep, pkg, evidence, env) {
  const branches = [{ name: "master", type: "branch" }];
  const run = {
    id: 10,
    run_attempt: 1,
    head_sha: m.identity.sourceCommit,
    head_branch: "master",
    event: "workflow_dispatch",
    path: ".github/workflows/introduce-production.yml",
    repository: m.identity.repository,
    repositoryId: 1,
    repositoryOwnerId: 2,
  };
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  const jobs = () => {
    const rows = [
      {
        name: "Introduce production",
        head_sha: m.identity.sourceCommit,
        status: "completed",
        conclusion: "success",
        started_at: iso(100),
        completed_at: iso(110),
      },
      {
        name: "Approve failed-unserved continuation",
        head_sha: m.identity.sourceCommit,
        status: "completed",
        conclusion: "skipped",
      },
      {
        name: "Continue failed-unserved introduction",
        head_sha: m.identity.sourceCommit,
        status: "completed",
        conclusion: "skipped",
      },
      {
        name: "Prepare production acceptance",
        head_sha: m.identity.sourceCommit,
        status: "in_progress",
        conclusion: null,
        started_at: iso(120),
        completed_at: null,
      },
    ];
    if (process.env.GITHUB_JOB === "accept") {
      rows[3] = {
        ...rows[3],
        status: "completed",
        conclusion: "success",
        completed_at: iso(125),
      };
      rows.push(
        {
          name: "Approve production acceptance",
          head_sha: m.identity.sourceCommit,
          status: "completed",
          conclusion: "success",
          started_at: iso(126),
          completed_at: iso(130),
        },
        {
          name: "Accept production introduction",
          head_sha: m.identity.sourceCommit,
          status: "in_progress",
          conclusion: null,
          started_at: iso(131),
          completed_at: null,
        },
      );
    }
    return { total_count: rows.length, jobs: rows };
  };
  mockExec.mockImplementation(async (_exe, args, options) => {
    const endpoint = args[1],
      query = args[args.indexOf("--jq") + 1];
    let value;
    if (endpoint.includes("chronote-ops/contents/"))
      expect(options.env.GH_TOKEN).toBe(env.INTRODUCTION_OPS_READ_TOKEN);
    if (endpoint.endsWith("/zip")) return { stdout: prep.state.archive };
    if (
      endpoint.includes("production-paused-drafts/") ||
      endpoint.includes("/runs/20") ||
      endpoint.includes("/artifacts/30")
    )
      value = prep.github(endpoint);
    else if (endpoint.includes("chronote-ops/contents/")) {
      const path = endpoint.split("/contents/")[1].split("?")[0],
        name = path.split("/").at(-1).replace(".json", "");
      value = privateFileResponse(
        path,
        name === "execution" ? pkg : evidence[name],
      );
    } else if (endpoint.endsWith("/runs/10")) value = run;
    else if (endpoint.endsWith("/approvals"))
      value = [
        {
          state: "approved",
          environments: [
            { id: 1, name: "production" },
            { id: 3, name: "production-acceptance" },
          ],
          userId: 7,
        },
      ];
    else if (
      endpoint.includes("deployment-branch-policies") &&
      query.startsWith("[")
    )
      value = branches;
    else if (
      /\/environments\/(production-continuation|production-acceptance)$/.test(
        endpoint,
      )
    )
      value = protectedEnvironment(endpoint.split("/").at(-1));
    else if (
      endpoint.includes("/runs/10/attempts/1/jobs") &&
      query.includes("started_at")
    )
      value = jobs();
    else value = await launcher.github(endpoint);
    return { stdout: JSON.stringify(value), stderr: "" };
  });
  mockAws.mockImplementation(async (service, op, input) => {
    if (service === "iam") return launcher.aws(service, op, input);
    if (service === "sts" && process.env.GITHUB_JOB !== "prepare-paused-drafts")
      return {
        Account: m.identity.accountId,
        Arn: `arn:aws:sts::${m.identity.accountId}:assumed-role/${process.env.GITHUB_JOB === "prepare-acceptance" ? "acceptance-reader/introduction-read-10-1" : "deploy/introduction-10-1"}`,
      };
    return prep.aws(service, op, input);
  });
  mockS3.mockImplementation(prep.send);
  mockDynamo.mockImplementation((command) => {
    if (command.constructor.name === "GetItemCommand") return {};
    const operations = {
      QueryCommand: "query",
      DescribeTimeToLiveCommand: "describe-time-to-live",
    };
    return prep.aws(
      "dynamodb",
      operations[command.constructor.name],
      command.input,
    );
  });
  return env;
}
async function setupChain() {
  jest
    .spyOn(globalThis, "structuredClone")
    .mockImplementation(cloneInTestRealm);
  jest.spyOn(Date, "now").mockReturnValue(150000);
  mockFile.mockImplementation(readOidcOnlySource);
  const m = completeManifest();
  m.operationId = "00000000-0000-4000-8000-000000000001";
  const launcher = launcherFixture(m);
  Object.assign(m.identity, {
    runId: "10",
    runAttempt: "1",
    sessionName: "introduction-10-1",
  });
  m.launcherRoutes = reviewedRoutes(m, readOidcOnlySource);
  launcher.declaration.routes = launcher.declaration.routes.map(
    (route, index) => ({ ...route, ...m.launcherRoutes[index] }),
  );
  const prep = pausedPreparationFixture(m);
  prep.request.validUntil = m.validUntil + 100;
  prep.request.storeBinding.retentionUntil = m.validUntil + 200;
  prep.env.PAUSED_PREPARATION_REQUEST_SHA256 = canonicalHash(prep.request);
  process.env = { ...prep.env };
  mockExec.mockImplementation(async (_exe, args) => ({
    stdout: JSON.stringify(prep.github(args[1])),
  }));
  mockAws.mockImplementation(prep.aws);
  mockS3.mockImplementation(prep.send);
  const receipt = await prepareOriginalPausedDrafts(),
    declaration = prep.finish(receipt),
    capture = JSON.parse(prep.state.capture.toString());
  const scope = {
    manifest: m,
    identities: prep.request.cohort,
    objects: capture.objects,
    request: prep.request,
  };
  bindPreservationPolicies(launcher, scope);
  const branches = [{ name: "master", type: "branch" }];
  const evidence = Object.fromEntries(
    Object.keys(m.prerequisites).map((name) => [name, { fixture: name }]),
  );
  Object.assign(evidence, {
    fixtureChecklist: frozenFixtureDefinitions(),
    launcherHolds: launcher.declaration,
    retainedDisposition: { pausedDesktopDrafts: declaration },
    executionApproval: {
      ...protectedPolicy("production", branches),
      continuationGate: {
        ...protectedPolicy("production-continuation", branches),
        jobName: "Approve failed-unserved continuation",
      },
    },
  });
  m.acceptance.gatePolicy = {
    ...protectedPolicy("production-acceptance", branches),
    environmentId: "3",
  };
  for (const name of Object.keys(evidence))
    m.prerequisites[name] = canonicalHash(evidence[name]);
  const manifest = structuredClone(m);
  Object.assign(manifest.identity, {
    runId: "$CURRENT",
    runAttempt: "$CURRENT",
    sessionName: "$CURRENT",
  });
  const pkg = {
    schemaVersion: 1,
    manifest,
    identitySlots: ["runId", "runAttempt", "sessionName"],
    repositoryId: "1",
    repositoryOwnerId: "2",
  };
  const env = originalEnvironment(m);
  env.INTRODUCTION_INTENT_HASH = packageIntentHash(pkg);
  wireGithub(m, launcher, prep, pkg, evidence, env);
  process.env = env;
  return { m, launcher, prep, pkg, evidence, env };
}
test.each(["introduce", "prepare-acceptance", "accept"])(
  "actual original package loader, authenticated producer, native policy and %s reader preserve same two IDs",
  async (mode) => {
    const f = await setupChain();
    process.env.GITHUB_JOB = mode;
    const loaded =
      mode === "introduce"
        ? await loadProductionPackage(process.env, mockAws, mode)
        : await loadAcceptancePackage();
    const authority = loaded.collection ?? loaded.binding;
    const cohort = bindOriginalPausedDisposition(
      authority,
      loaded.evidence,
      loaded.pausedPreparation,
    );
    const settings = await collectLauncherSettingsFromOriginalRun();
    const checked = readPausedEffectivePolicyScope(
      settings,
      cohort,
      mode === "prepare-acceptance" ? "collector" : "introduction",
    );
    expect(checked.captureHash).toBe(f.prep.state.reference.sha256);
    const provider = loaded.collection
      ? createAcceptanceReadAws(loaded.collection)
      : createProductionAws(loaded.binding);
    expect(readPausedReaderScope(cohort).manifest).toEqual(
      loaded.collection
        ? readCollectionBinding(loaded.collection).manifest
        : loaded.binding.manifest,
    );
    const acquired = await collectPausedDraftMetadata(
      cohort,
      provider,
      "before_stop",
      settings,
    );
    const value = readPausedCohort(acquired, "before_stop");
    expect(value.identities.map((id) => id.uploadId)).toEqual(["one", "two"]);
    expect(JSON.stringify(value.parents)).not.toContain("PRIVATE SENTINEL");
    mockDynamo.mockClear();
    mockS3.mockClear();
    for (const [selectedCohort, selectedSettings] of [
      [{ ...cohort }, settings],
      [cohort, { ...settings }],
    ])
      await expect(
        provider.pausedDraftMetadata(selectedCohort, selectedSettings, {
          kind: "parent",
          uploadId: "one",
        }),
      ).rejects.toThrow();
    expect(mockDynamo).not.toHaveBeenCalled();
    expect(mockS3).not.toHaveBeenCalled();
    expect(() =>
      readPausedEffectivePolicyScope(
        settings,
        cohort,
        mode === "prepare-acceptance" ? "introduction" : "collector",
      ),
    ).toThrow();
    if (loaded.collection) {
      expect(readCollectionBinding(loaded.collection).actor).toContain(
        "introduction-read-10-1",
      );
      expect(() =>
        bindOriginalPausedDisposition(
          structuredClone(loaded.collection),
          loaded.evidence,
          loaded.pausedPreparation,
        ),
      ).toThrow();
    }
  },
);
