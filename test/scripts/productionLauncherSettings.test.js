/** @jest-environment node */
import {
  mockPreparationAws as mockAws,
  mockPreparationS3 as mockSend,
} from "../fixtures/productionPreparationTransport.js";
import { expect, test, jest, beforeEach, afterEach } from "@jest/globals";
import { canonicalHash as hash } from "../../scripts/deployment/production-manifest.cjs";
import process from "node:process";
import { readFileSync as mockFile } from "node:fs";
import {
  launcherFixture,
  bindPreservationPolicies,
} from "../fixtures/productionLauncher.js";
import {
  reviewedRoutes,
  readOidcOnlySource,
  readStaticCredentialSource,
} from "../fixtures/productionReviewedSource.js";
import { runCli } from "../../scripts/deployment/introduce-production.cjs";
import {
  collectLauncherSettingsFromOriginalRun,
  readLauncherSettings,
  readPausedEffectivePolicyScope,
} from "../../scripts/deployment/production-launcher-settings.cjs";
const mockLoad = jest.fn(),
  mockGithub = jest.fn(),
  mockExec = jest.fn();
jest.mock("../../scripts/deployment/production-private-package.cjs", () => ({
  loadAcceptancePackage: () => mockLoad(),
  loadProductionPackage: () => mockLoad(),
  githubJson: (...args) => mockGithub(...args),
}));
jest.mock("../../scripts/deployment/production-aws.cjs", () => ({
  createProductionAws: () => ({ aws: (...args) => mockAws(...args) }),
}));
jest.mock("node:fs", () => {
  const actual = jest.requireActual("node:fs");
  return { ...actual, readFileSync: jest.fn(actual.readFileSync) };
});
jest.mock("node:child_process", () =>
  jest
    .requireActual("../fixtures/productionProcessMock.js")
    .reviewedProcessModuleMock((...args) => mockExec(...args)),
);

let f;
function bindSource(read) {
  mockFile.mockImplementation(read);
  f.binding.manifest.launcherRoutes = reviewedRoutes(f.binding.manifest, read);
  f.declaration.routes = f.declaration.routes.map((route, index) => ({
    ...route,
    ...f.binding.manifest.launcherRoutes[index],
  }));
  f.binding.manifest.prerequisites.launcherHolds = hash(f.declaration);
  f.binding.manifestHash = hash(f.binding.manifest);
}
beforeEach(() => {
  f = launcherFixture();
  bindSource(readOidcOnlySource);
  process.env.GITHUB_JOB = "accept";
  process.env.INTRODUCTION_OPS_READ_TOKEN = "dummy-read";
  jest.spyOn(Date, "now").mockReturnValue(320000);
  mockLoad.mockImplementation(async () => ({
    binding: f.binding,
    evidence: { launcherHolds: f.declaration },
  }));
  mockGithub.mockImplementation(f.github);
  mockAws.mockImplementation(f.aws);
});

test.each(["introduce", "prepare-acceptance", "accept"])(
  "injected static deployment source cannot mint fresh %s launcher authority despite valid settings",
  async (mode) => {
    bindSource(readStaticCredentialSource);
    process.env.GITHUB_JOB = mode;
    await expect(collectLauncherSettingsFromOriginalRun()).rejects.toThrow(
      "unaccounted_static_credential_route",
    );
    expect(mockAws).not.toHaveBeenCalled();
    expect(mockGithub).not.toHaveBeenCalled();
  },
);

test("original entrypoint refuses an injected static route before hold acquisition or interruption", async () => {
  bindSource(readStaticCredentialSource);
  process.env.GITHUB_JOB = "introduce";
  const output = { log: jest.fn(), error: jest.fn() };
  expect(await runCli(["introduce"], output)).toBe(1);
  expect(output.log).not.toHaveBeenCalled();
  expect(mockAws).not.toHaveBeenCalled();
});
afterEach(() => {
  jest.restoreAllMocks();
  mockLoad.mockReset();
  mockGithub.mockReset();
  mockAws.mockReset();
  mockSend.mockReset();
  mockExec.mockReset();
});
test("actual no-argument producer compares original settings, emits only bounded metadata and rejects copies", async () => {
  const token = await collectLauncherSettingsFromOriginalRun();
  expect(readLauncherSettings(token, f.binding)).toMatchObject({
    mode: "zero-external-launcher-mutations",
    baselineHash: f.binding.manifest.prerequisites.launcherHolds,
    observedAt: 320,
  });
  expect(mockLoad).toHaveBeenCalledWith();
  expect(mockGithub.mock.calls.every((c) => c[2] === "dummy-read")).toBe(true);
  expect(
    mockAws.mock.calls.every(([, operation]) => /^(get|list)-/.test(operation)),
  ).toBe(true);
  for (const copied of [
    { ...token },
    JSON.parse(JSON.stringify(token)),
    { verified: true },
  ])
    expect(() => readLauncherSettings(copied)).toThrow();
  Date.now.mockReturnValue(f.binding.manifest.validUntil * 1000);
  expect(() => readLauncherSettings(token)).toThrow();
});
test.each([
  "extraRun",
  "missingVariable",
  "missingRepositoryVariable",
  "repositoryVariableChanged",
  "roleIdChanged",
  "attachmentChanged",
  "classicDenied",
  "branchChanged",
  "partialJobs",
])("rejects authenticated %s without a token", async (key) => {
  f.state[key] = true;
  await expect(collectLauncherSettingsFromOriginalRun()).rejects.toThrow();
});
test("original prerequisite cannot be replaced by caller data or a later missing-purpose baseline", async () => {
  f.declaration.roles.pop();
  await expect(
    collectLauncherSettingsFromOriginalRun({ verified: true }),
  ).rejects.toThrow();
});
test("expiry after provider reads produces no token", async () => {
  mockAws.mockImplementation(async (...args) => {
    const value = await f.aws(...args);
    Date.now.mockReturnValue(f.binding.manifest.validUntil * 1000);
    return value;
  });
  await expect(collectLauncherSettingsFromOriginalRun()).rejects.toThrow();
});

function policyDocument(change, reads, original) {
  if (change === "unknown-delegation")
    return { Statement: [{ Effect: "Allow", Action: "sts:*", Resource: "*" }] };
  if (change === "inline-drift" && reads > 2) return { Statement: [] };
  return original;
}
test.each([
  "stable",
  "version-drift",
  "inline-drift",
  "unknown-delegation",
  "pagination-loop",
])(
  "real IAM reader binds paginated inline, attached and boundary policy documents: %s",
  async (change) => {
    const role = f.declaration.roles.find((r) => r.purpose === "task"),
      name = role.arn.split("/").at(-1);
    const arn = `arn:aws:iam::${f.binding.manifest.identity.accountId}:policy/exact-policy`;
    const doc = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "dynamodb:GetItem",
          Resource: "arn:aws:dynamodb:us-east-1:123456789012:table/exact",
        },
      ],
    };
    role.inline = ["a", "b"].map((name) => ({ name, documentHash: hash(doc) }));
    role.attached = [{ arn, versionId: "v1", documentHash: hash(doc) }];
    role.boundary = { arn, versionId: "v1", documentHash: hash(doc) };
    f.roleRows.get(name).PermissionsBoundary = {
      PermissionsBoundaryType: "Policy",
      PermissionsBoundaryArn: arn,
    };
    f.binding.manifest.prerequisites.launcherHolds = hash(f.declaration);
    f.binding.manifestHash = hash(f.binding.manifest);
    let versions = 0,
      inlineReads = 0;
    mockAws.mockImplementation(async (service, op, input) => {
      if (input.RoleName === name && op === "list-role-policies")
        return input.Marker
          ? {
              PolicyNames: ["b"],
              IsTruncated: change === "pagination-loop",
              ...(change === "pagination-loop" ? { Marker: "next" } : {}),
            }
          : { PolicyNames: ["a"], IsTruncated: true, Marker: "next" };
      if (input.RoleName === name && op === "list-attached-role-policies")
        return { AttachedPolicies: [{ PolicyArn: arn }], IsTruncated: false };
      if (op === "get-role-policy") {
        inlineReads++;
        return {
          RoleName: name,
          PolicyName: input.PolicyName,
          PolicyDocument: policyDocument(change, inlineReads, doc),
        };
      }
      if (op === "get-policy")
        return {
          Policy: {
            Arn: arn,
            DefaultVersionId:
              change === "version-drift" && ++versions > 1 ? "v2" : "v1",
          },
        };
      if (op === "get-policy-version")
        return {
          PolicyVersion: {
            VersionId: "v1",
            IsDefaultVersion: true,
            Document: doc,
          },
        };
      return f.aws(service, op, input);
    });
    if (change === "stable")
      expect(
        readLauncherSettings(
          await collectLauncherSettingsFromOriginalRun(),
          f.binding,
        ).mode,
      ).toBe("zero-external-launcher-mutations");
    else
      await expect(collectLauncherSettingsFromOriginalRun()).rejects.toThrow();
  },
);

// Positive fixtures deliberately use synthetic OIDC-only workflow source.
test.each(["SECRETS_PREFIX", "LANGFUSE_BASE_URL", "ECS_TASK_FAMILY"])(
  "connection-sync selector %s drift cannot mint launcher authority",
  async (selector) => {
    mockGithub.mockImplementation(async (...args) => {
      const result = await f.github(...args);
      if (args[0].includes("/environments/production/variables?"))
        result.items = result.items.map((item) =>
          item.name === selector ? { ...item, value: "changed" } : item,
        );
      return result;
    });
    await expect(collectLauncherSettingsFromOriginalRun()).rejects.toThrow();
  },
);

test("native settings producer retains authenticated preparation and checked policy authority", async () => {
  const { pausedPreparationFixture } =
    await import("../fixtures/productionPausedPreparation.js");
  const { bound } = await import("../fixtures/productionManifest.js");
  const { prepareOriginalPausedDrafts } =
    await import("../../scripts/deployment/production-paused-preparation.cjs");
  const { authenticateOriginalPausedPreparation } =
    await import("../../scripts/deployment/production-paused-draft-binding.cjs");
  const { bindOriginalPausedDisposition } =
    await import("../../scripts/deployment/production-paused-drafts.cjs");
  const m = f.binding.manifest;
  m.operationId = "00000000-0000-4000-8000-000000000001";
  const prep = pausedPreparationFixture(m),
    oldEnv = process.env;
  prep.request.validUntil = m.validUntil + 100;
  prep.request.storeBinding.retentionUntil = m.validUntil + 200;
  prep.env.PAUSED_PREPARATION_REQUEST_SHA256 = hash(prep.request);
  process.env = { ...prep.env };
  mockGithub.mockImplementation(prep.github);
  mockAws.mockImplementation(prep.aws);
  mockSend.mockImplementation(prep.send);
  mockExec.mockImplementation(async () => ({ stdout: prep.state.archive }));
  try {
    const receipt = await prepareOriginalPausedDrafts(),
      declaration = prep.finish(receipt);
    const capture = JSON.parse(prep.state.capture.toString());
    const scope = {
      manifest: m,
      identities: prep.request.cohort,
      objects: capture.objects,
      request: prep.request,
    };
    bindPreservationPolicies(f, scope);
    const evidence = {
      launcherHolds: f.declaration,
      retainedDisposition: { pausedDesktopDrafts: declaration },
    };
    m.prerequisites.retainedDisposition = hash(evidence.retainedDisposition);
    f.binding = bound(m);
    const pausedPreparation = await authenticateOriginalPausedPreparation(
      f.binding,
      evidence,
      "synthetic-github",
    );
    const cohort = bindOriginalPausedDisposition(
      f.binding,
      evidence,
      pausedPreparation,
    );
    process.env = { ...oldEnv, GITHUB_JOB: "introduce" };
    mockLoad.mockResolvedValue({
      binding: f.binding,
      evidence,
      pausedPreparation,
    });
    mockGithub.mockImplementation(f.github);
    mockAws.mockImplementation(f.aws);
    const token = await collectLauncherSettingsFromOriginalRun();
    const checked = readPausedEffectivePolicyScope(
      token,
      cohort,
      "introduction",
    );
    expect(checked).toMatchObject({
      purpose: "introduction",
      actor: f.binding.actor,
      captureHash: declaration.capture.sha256,
    });
    expect(checked.scopeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      readPausedEffectivePolicyScope({ ...token }, cohort),
    ).toThrow();
    expect(() =>
      readPausedEffectivePolicyScope(token, { ...cohort }),
    ).toThrow();
    expect(() =>
      readPausedEffectivePolicyScope(token, cohort, "collector"),
    ).toThrow();
    Date.now.mockReturnValue(330000);
    const fresh = await collectLauncherSettingsFromOriginalRun();
    expect(readPausedEffectivePolicyScope(fresh, cohort).scopeSha256).toBe(
      checked.scopeSha256,
    );
  } finally {
    process.env = oldEnv;
  }
});
