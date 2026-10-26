/** @jest-environment node */
import process from "node:process";
import { expect, test, jest, beforeEach, afterEach } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import { contentFixture } from "../fixtures/productionFixtureContent.js";
import { writerFixture } from "../fixtures/productionAcceptanceWriters.js";
import { authorityFor } from "../../scripts/deployment/introduction-hold.cjs";
import { action as routeAction } from "../../scripts/deployment/routing.cjs";
import { inspectFixtureMetadata } from "../../src/services/productionFixtureAcceptance";
import {
  collectAcceptanceFromOriginalRun,
  readAcceptance,
  transactionInputs,
  acceptanceSummary,
} from "../../scripts/deployment/production-acceptance-collector.cjs";
const mockLoad = jest.fn(),
  mockContent = jest.fn(),
  mockRead = jest.fn(),
  mockAws = jest.fn(),
  mockScan = jest.fn(),
  mockHistory = jest.fn(),
  mockInventory = jest.fn(),
  mockLauncher = jest.fn();
let state, mockFixture, mockHistoryValue, loaded;
jest.mock("../../scripts/deployment/production-private-package.cjs", () => ({
  loadAcceptancePackage: () => mockLoad(),
  readCollectionBinding: () => mockFixture.binding,
  verifyOwnershipEvidence: async () => ({
    consumerSourceCommit: mockFixture.binding.manifest.identity.sourceCommit,
    ownershipEvidenceHash: "f".repeat(64),
    reviewedDispositionHash: "f".repeat(64),
  }),
}));
jest.mock("../../scripts/deployment/production-fixture-content.cjs", () => ({
  collectGeneratedFixturesFromOriginalRun: () => mockContent(),
  readGeneratedFixtures: () => mockFixture,
}));
jest.mock("../../scripts/deployment/production-launcher-settings.cjs", () => ({
  collectLauncherSettingsFromOriginalRun: () => mockLauncher(),
  readLauncherSettings: () => mockHistoryValue.launcher,
}));
jest.mock("../../scripts/deployment/production-aws.cjs", () => ({
  createProductionAws: () => ({
    read: (...a) => mockRead(...a),
    aws: (...a) => mockAws(...a),
    scan: (...a) => mockScan(...a),
  }),
  createAcceptanceReadAws: () => ({
    read: (...a) => mockRead(...a),
    aws: (...a) => mockAws(...a),
  }),
}));
jest.mock("../../scripts/deployment/production-acceptance-history.cjs", () => ({
  ...jest.requireActual(
    "../../scripts/deployment/production-acceptance-history.cjs",
  ),
  readIntroductionHistory: (...a) => mockHistory(...a),
}));
jest.mock("../../scripts/deployment/production-inventory.cjs", () => ({
  collectAcceptanceInventory: (...a) => mockInventory(...a),
}));
jest.mock("../../scripts/deployment/production-inventory-adapter.cjs", () => ({
  createInventoryReader: () => ({ read: jest.fn() }),
}));
jest.mock("../../scripts/deployment/production-source-routes.cjs", () => ({
  verifyDeclaredRoutes: jest.fn(),
}));
beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(720000);
  process.env.GITHUB_JOB = "accept";
  const raw = contentFixture({ secondOffsetSeconds: 400 });
  state = writerFixture();
  for (const r of state.runtimes) {
    r.protection.expiresAt = 2000;
    r.readiness.provenAt = 720;
    r.readiness.expiresAt = 900;
  }
  state.runtimes[0].retirementAcknowledgment.retiredAt = 320;
  state.inventory.tasks[2].protectionExpiresAt = new Date(
    2000000,
  ).toISOString();
  const fixtures = raw.fixtures.map((v) => ({
    metadata: inspectFixtureMetadata({
      grant: v.grant,
      history: v.history,
      validFrom: raw.binding.manifest.validFrom,
      now: 720,
    }),
    runtime: state.runtimes.find(
      (r) => r.identity.instanceId === v.runtime.identity.instanceId,
    ),
    fallbackSource: [],
    contents: {
      manifest: JSON.parse(
        raw.objects.get(v.history.checkpoint.manifest.key).bytes.toString(),
      ),
      audio: new Map(
        [...raw.objects]
          .filter(([key]) => key.includes("/audio/"))
          .map(([key, value]) => [key, value.bytes]),
      ),
      notes: v.notes,
    },
  }));
  mockFixture = {
    binding: raw.binding,
    hold: raw.hold,
    control: state.control,
    fixtureAuthority: raw.authority,
    fixtures,
    pinned: {
      supplementCommit: "a".repeat(40),
      supplementHash: "b".repeat(64),
    },
    supplement: {
      ...raw.supplement,
      reviewedAt: new Date(719000).toISOString(),
    },
    deadline: raw.binding.manifest.validUntil,
  };
  const launcher = {
    kind: "launcher_settings",
    mode: "zero-external-launcher-mutations",
    manifestHash: mockFixture.binding.manifestHash,
    baselineHash: mockFixture.binding.manifest.prerequisites.launcherHolds,
    sourceCommit: mockFixture.binding.manifest.identity.sourceCommit,
    observedAt: 120,
    coverage: [
      "github_routes",
      "github_environment",
      "github_branch",
      "github_variables",
      "github_actions",
      "resumable_jobs",
      "named_roles",
      "oidc",
    ],
  };
  mockHistoryValue = {
    authority: authorityFor(mockFixture.binding),
    entries: [
      {
        action: { kind: "stop_service" },
        row: {
          submittedAt: 150,
          acknowledgment: { facts: { launcherBaseline: launcher } },
        },
      },
    ],
    handoffAt: new Date(200000).toISOString(),
    retiredAt: 320,
    complete: {
      observedAt: 321,
      observation: { facts: { runtime: state.runtimes[0] } },
    },
    launcher,
  };
  loaded = {
    binding: mockFixture.binding,
    evidence: {
      retainedDisposition: {
        schemaVersion: 1,
        predicate: "missing-owner-or-version-v1",
        sourceCommit: mockFixture.binding.manifest.identity.sourceCommit,
        records: [],
      },
    },
  };
  mockLoad.mockImplementation(async () => loaded);
  mockContent.mockResolvedValue({});
  mockLauncher.mockResolvedValue({});
  mockHistory.mockImplementation(async () => mockHistoryValue);
  mockInventory.mockImplementation(async () => state.inventory);
  mockRead.mockResolvedValue(undefined);
  mockScan.mockResolvedValue({ Items: [] });
  mockAws.mockImplementation(async (service, operation) => {
    if (operation === "query")
      return { Items: state.runtimes.map((r) => marshall(r)) };
    if (operation === "describe-listeners")
      return {
        Listeners: [
          {
            ListenerArn: state.m.resources.listenerArn,
            Protocol: "HTTPS",
            DefaultActions: routeAction(state.control.deployment.routing, true),
          },
        ],
      };
    if (operation === "describe-rules") return { Rules: [{ IsDefault: true }] };
    if (operation === "describe-services")
      return {
        services: [
          {
            taskDefinition: state.m.runtime.continuationDefinition,
            desiredCount: 1,
            pendingCount: 0,
            deploymentController: { type: "ECS" },
            loadBalancers: [
              {
                targetGroupArn: state.m.resources.targetGroupB,
                containerName: "app",
                containerPort: 3001,
              },
            ],
          },
        ],
        failures: [],
      };
    throw Error(`unexpected ${service}/${operation}`);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const m of [
    mockLoad,
    mockContent,
    mockRead,
    mockAws,
    mockScan,
    mockHistory,
    mockInventory,
    mockLauncher,
  ])
    m.mockReset();
});
test("authenticated composition checks actual saved audio chronology, scans fresh final metadata and rejects copied authority", async () => {
  const token = await collectAcceptanceFromOriginalRun();
  expect(readAcceptance(token).stage.action.purpose).toBe("persist_acceptance");
  expect(mockLoad).toHaveBeenCalledWith();
  expect(mockContent).toHaveBeenCalledWith();
  expect(mockLauncher).toHaveBeenCalledWith();
  expect(mockScan).toHaveBeenCalledTimes(8);
  for (const copied of [
    { ...token },
    JSON.parse(JSON.stringify(token)),
    { accepted: true },
  ])
    expect(() => readAcceptance(copied)).toThrow();
  const read = readAcceptance(token);
  read.f.control.servingGeneration = 999;
  expect(readAcceptance(token).f.control.servingGeneration).toBe(2);
  Date.now.mockReturnValue(mockFixture.deadline * 1000);
  expect(() => readAcceptance(token)).toThrow();
});
test("prepare never scans or mints transaction inputs and labels retained classification UNVERIFIED", async () => {
  loaded = { collection: {}, evidence: loaded.evidence };
  process.env.GITHUB_JOB = "prepare-acceptance";
  const token = await collectAcceptanceFromOriginalRun();
  expect(mockScan).not.toHaveBeenCalled();
  expect(acceptanceSummary(token).retainedWorkClassification).toBe(
    "UNVERIFIED",
  );
  expect(() => transactionInputs(token, {})).toThrow();
});
test.each([
  "loader",
  "history",
  "launcher",
  "unknown-writer",
  "pending-owner",
  "unknown-receipt",
  "missing-page",
  "late-second",
  "missing-baseline",
  "unknown-final-action",
])("does not mint acceptance when %s is missing or changed", async (reason) => {
  if (reason === "loader") mockLoad.mockRejectedValue(Error("untrusted"));
  if (reason === "history")
    mockHistory.mockRejectedValue(Error("typed historical ACK missing"));
  if (reason === "launcher")
    mockLauncher.mockRejectedValue(Error("settings drift"));
  if (reason === "unknown-writer")
    state.inventory.tasks.push({
      ...state.inventory.tasks[2],
      taskArn: "unknown",
    });
  if (reason === "pending-owner")
    state.runtimes[1].workCounts.pending_admission = 1;
  if (reason === "unknown-receipt")
    mockScan.mockImplementation(async (_op, input) => ({
      Items:
        input.TableName === state.m.resources.tables.stripeWebhook
          ? [marshall({ eventId: "unknown", state: "processing" })]
          : [],
    }));
  if (reason === "missing-page") mockScan.mockResolvedValue({});
  if (reason === "late-second") mockHistoryValue.retiredAt = 600;
  if (reason === "missing-baseline")
    delete mockHistoryValue.entries[0].row.acknowledgment.facts
      .launcherBaseline;
  if (reason === "unknown-final-action")
    mockRead.mockResolvedValue({ phase: "submitted" });
  await expect(collectAcceptanceFromOriginalRun()).rejects.toThrow();
});
