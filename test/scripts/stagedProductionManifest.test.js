/** @jest-environment node */
import { fixture, bound } from "../fixtures/productionManifest.js";
import {
  parseExecution,
  canonicalHash,
  assertBoundExecution,
} from "../../scripts/deployment/production-manifest.cjs";
import { expect, test } from "@jest/globals";
import {
  manifestFixture,
  phaseAuthorization,
} from "../fixtures/deployment/productionIntroduction.js";
import {
  manifestHash,
  parseManifest,
} from "../../scripts/deployment/sandbox-manifest.cjs";
import {
  parseProductionManifest,
  parsePhaseAuthorization,
} from "../../scripts/deployment/staged-production-manifest.cjs";

import { rehearsalFixture } from "../fixtures/deployment/rehearsalIntroduction.js";
import { buildMaintenancePolicy } from "../../scripts/deployment/maintenance-fence.cjs";

const authorization = (m) => phaseAuthorization(m, "fence");
test("strict production manifest accepts exact operation and Sandbox rejects it", () => {
  const m = manifestFixture();
  expect(parseProductionManifest(m, manifestHash(m))).toEqual(m);
  expect(() => parseManifest(m, manifestHash(m))).toThrow();
});
test.each([
  "environment",
  "kind",
  "ownedPolicySha256",
  "taskDefinition",
  "controlTableArn",
])("rejects changed %s", (field) => {
  const m = manifestFixture();
  m[field] = "invalid";
  expect(() => parseProductionManifest(m, manifestHash(m))).toThrow();
});
test("requires reviewed manifest hash", () => {
  const m = manifestFixture();
  expect(() => parseProductionManifest(m, "0".repeat(64))).toThrow();
});
test("accepts exact invocation envelope", () => {
  const m = manifestFixture(),
    a = authorization(m);
  expect(parsePhaseAuthorization(a, m, manifestHash(m))).toEqual(a.envelope);
});
test.each([
  "bindSha256",
  "expectedSha256",
  "currentRunId",
  "currentRunAttempt",
])("rejects delivery substitution %s", (field) => {
  const m = manifestFixture(),
    a = authorization(m);
  a[field] = "wrong";
  expect(() => parsePhaseAuthorization(a, m, manifestHash(m))).toThrow();
});
test.each([
  "operationId",
  "manifestSha256",
  "principalArn",
  "sourceSha",
  "phase",
  "runAttempt",
])("rejects invalid envelope %s even when rehashed", (field) => {
  const m = manifestFixture(),
    a = authorization(m);
  a.envelope[field] = "wrong";
  a.expectedSha256 = a.bindSha256 = manifestHash(a.envelope);
  expect(() => parsePhaseAuthorization(a, m, manifestHash(m))).toThrow();
});

test.each([
  "fallbackTaskDefinition",
  "fallbackSourceSha",
  "fallbackDigest",
  "targetDeploymentConfiguration",
])("requires explicit approved fallback/controller %s", (field) => {
  const m = manifestFixture();
  delete m[field];
  expect(() => parseProductionManifest(m, manifestHash(m))).toThrow();
});
test("refuses automatic rollback in the approved target configuration", () => {
  const m = manifestFixture();
  m.targetDeploymentConfiguration.deploymentCircuitBreaker.rollback = true;
  expect(() => parseProductionManifest(m, manifestHash(m))).toThrow();
});

test("accepts explicitly bound candidate-equal fallback definition source and digest", () => {
  const m = manifestFixture();
  m.fallbackTaskDefinition = m.taskDefinition;
  m.fallbackSourceSha = m.binding.sourceSha;
  m.fallbackDigest = m.binding.candidateDigest;
  expect(parseProductionManifest(m, manifestHash(m))).toEqual(m);
});

test.each(["taskDefinition", "fallbackTaskDefinition"])(
  "rejects legacy as %s",
  (field) => {
    const m = manifestFixture();
    m[field] = m.legacyTaskDefinition;
    expect(() => parseProductionManifest(m, manifestHash(m))).toThrow();
  },
);

// Production must reject the reserved namespace even after valid packet rehashing.
const reservedName = "cr-0123456789abcdef-resource";
function expectNonproduction(m) {
  m.ownedPolicySha256 = manifestHash(buildMaintenancePolicy(m.binding));
  expect(() => parseProductionManifest(m, manifestHash(m))).toThrow(
    "Nonproduction resource",
  );
}
test("rejects a correctly rehashed rehearsal inventory relabeled as production", () => {
  const m = rehearsalFixture();
  delete m.disposablePrefix;
  delete m.resourceEvidence;
  m.kind = "production-introduction";
  m.environment = "production";
  expectNonproduction(m);
});
test.each(["service", "bucket", "containerName", "imageRepository"])(
  "rejects an isolated reserved %s from another operation",
  (field) => {
    const m = manifestFixture();
    m[field] = reservedName;
    expectNonproduction(m);
  },
);
test("rejects a reserved cluster with its matching legacy task ARN", () => {
  const m = manifestFixture();
  m.legacyTaskArn = m.legacyTaskArn.replace(m.cluster, reservedName);
  m.cluster = reservedName;
  expectNonproduction(m);
});
test.each(["deploymentRoleArn", "executionRoleArn", "taskRoleArn"])(
  "rejects an isolated reserved %s after an IAM path",
  (field) => {
    const m = manifestFixture();
    const holder = field === "taskRoleArn" ? m.binding : m;
    holder[field] =
      `arn:aws:iam::${m.binding.accountId}:role/production/${reservedName}`;
    expectNonproduction(m);
  },
);
test.each(["taskDefinition", "legacyTaskDefinition", "fallbackTaskDefinition"])(
  "rejects an isolated reserved %s family",
  (field) => {
    const m = manifestFixture();
    m[field] = m[field].replace("chronote-bot", reservedName);
    expectNonproduction(m);
  },
);
test.each(["listenerArn", "targetGroupA", "targetGroupB"])(
  "rejects an isolated reserved %s resource name",
  (field) => {
    const m = manifestFixture();
    m[field] = m[field].replace(/chronote(?:-[ab])?/, reservedName);
    expectNonproduction(m);
  },
);
test("rejects one reserved table among otherwise production table names", () => {
  const m = manifestFixture();
  m.tablePrefix = "cr-";
  for (const slot of Object.keys(m.binding.tableArns)) {
    m.binding.tableArns[slot] = m.binding.tableArns[slot].replace(
      "chronote-",
      "cr-production-",
    );
  }
  m.binding.activeMeetingTableArn = m.binding.tableArns.leases;
  m.binding.personalMediaUploadJobTableArn = m.binding.tableArns.uploads;
  m.controlTableArn = m.controlTableArn.replace("chronote-", "cr-");
  m.binding.tableArns.history = m.binding.tableArns.history.replace(
    "cr-production-MeetingHistoryTable",
    reservedName,
  );
  expectNonproduction(m);
});
test("does not treat unrelated ARN path and identifier text as reserved names", () => {
  const m = manifestFixture();
  m.deploymentRoleArn = m.deploymentRoleArn.replace(
    "role/",
    `role/${reservedName}/`,
  );
  m.listenerArn += `/${reservedName}`;
  m.targetGroupA += `/${reservedName}`;
  m.bucket = `production-${reservedName}`;
  expect(parseProductionManifest(m, manifestHash(m))).toEqual(m);
});

test("A whole-package authority and staged phase authority are not interchangeable", () => {
  const staged = manifestFixture(),
    whole = fixture();
  expect(() => parseProductionManifest(whole, manifestHash(whole))).toThrow();
  expect(() => parseExecution(staged, canonicalHash(staged))).toThrow();
  expect(() =>
    parsePhaseAuthorization(bound(), staged, manifestHash(staged)),
  ).toThrow();
  expect(() =>
    assertBoundExecution(phaseAuthorization(staged, "fence")),
  ).toThrow();
});
