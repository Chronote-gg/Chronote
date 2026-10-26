/** @jest-environment node */
import { expect, test, jest, beforeEach, afterEach } from "@jest/globals";
import { canonicalHash as hash } from "../../scripts/deployment/production-manifest.cjs";
import process from "node:process";
import { readFileSync as mockFile } from "node:fs";
import { launcherFixture } from "../fixtures/productionLauncher.js";
import {
  reviewedRoutes,
  readActualSource,
  readOidcOnlySource,
} from "../fixtures/productionReviewedSource.js";
import { runCli } from "../../scripts/deployment/introduce-production.cjs";
import {
  collectLauncherSettingsFromOriginalRun,
  readLauncherSettings,
} from "../../scripts/deployment/production-launcher-settings.cjs";
const mockLoad = jest.fn(),
  mockGithub = jest.fn(),
  mockAws = jest.fn();
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
jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  execFileSync: jest.fn((_file, args) =>
    args[0] === "rev-parse" ? "a".repeat(40) : "",
  ),
}));
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
  "actual deployment source cannot mint fresh %s launcher authority despite valid settings",
  async (mode) => {
    bindSource(readActualSource);
    process.env.GITHUB_JOB = mode;
    await expect(collectLauncherSettingsFromOriginalRun()).rejects.toThrow(
      "unaccounted_static_credential_route",
    );
    expect(mockAws).not.toHaveBeenCalled();
    expect(mockGithub).not.toHaveBeenCalled();
  },
);

test("original entrypoint refuses the actual static route before hold acquisition or interruption", async () => {
  bindSource(readActualSource);
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
