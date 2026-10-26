/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { manifestFixture } from "../fixtures/deployment/productionIntroduction.js";
import { manifestHash } from "../../scripts/deployment/sandbox-manifest.cjs";
import { parseRehearsalManifest } from "../../scripts/deployment/rehearsal-manifest.cjs";

test("a renamed production packet cannot authorize rehearsal resources", () => {
  const m = {
    ...manifestFixture(),
    kind: "rehearsal-introduction",
    environment: "rehearsal",
  };
  expect(() => parseRehearsalManifest(m, manifestHash(m))).toThrow();
});

import {
  rehearsalFixture,
  rehearsalAuthorization,
} from "../fixtures/deployment/rehearsalIntroduction.js";
import { parseRehearsalAuthorization } from "../../scripts/deployment/rehearsal-manifest.cjs";
import {
  parseProductionManifest,
  parsePhaseAuthorization,
} from "../../scripts/deployment/production-manifest.cjs";
import { parseManifest } from "../../scripts/deployment/sandbox-manifest.cjs";
import {
  createRehearsalIntroduction,
  runCli,
} from "../../scripts/deployment/rehearse-introduction.cjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("disposable declarations and rehearsal session bind without weakening either other environment", () => {
  const m = rehearsalFixture();
  expect(parseRehearsalManifest(m, manifestHash(m))).toEqual(m);
  expect(
    parseRehearsalAuthorization(rehearsalAuthorization(m), m, manifestHash(m))
      .kind,
  ).toBe("rehearsal-phase");
  expect(() => parseProductionManifest(m, manifestHash(m))).toThrow();
  expect(() => parseManifest(m, manifestHash(m))).toThrow();
  expect(() =>
    parsePhaseAuthorization(rehearsalAuthorization(m), m, manifestHash(m)),
  ).toThrow();
});
test.each([
  (m) => {
    m.environment = "sandbox";
  },
  (m) => {
    m.binding.accountId = "999999999999";
  },
  (m) => {
    m.binding.region = "eu-west-1";
  },
  (m) => {
    m.binding.operationId = "00000000-0000-4000-8000-000000000000";
  },
  (m) => {
    m.service = "chronote-sandbox-service";
  },
  (m) => {
    m.taskDefinition = manifestFixture().taskDefinition;
  },
  (m) => {
    m.resourceEvidence.pop();
  },
  (m) => {
    m.resourceEvidence.push(m.resourceEvidence[0]);
  },
  (m) => {
    m.resourceEvidence[0].arn = manifestFixture().binding.taskRoleArn;
  },
  (m) => {
    m.resourceEvidence[0].tags.OperationId =
      "00000000-0000-4000-8000-000000000000";
  },
  (m) => {
    m.resourceEvidence[0].tags.Environment = "production";
  },
  (m) => {
    m.resourceEvidence[0].verified = true;
  },
  (m) => {
    m.targetGroupA = m.targetGroupA.replace(
      m.disposablePrefix + "a/",
      m.disposablePrefix + "a".repeat(20) + "/",
    );
  },
])("rejects untrusted or mixed disposable declarations %#", (change) => {
  const m = rehearsalFixture();
  change(m);
  expect(() => parseRehearsalManifest(m, manifestHash(m))).toThrow();
});
test.each(["kind", "principalArn", "operationId", "sourceSha", "runId"])(
  "rejects substituted authorization %s",
  (field) => {
    const m = rehearsalFixture(),
      a = rehearsalAuthorization(m);
    a.envelope[field] = "invalid";
    a.expectedSha256 = a.bindSha256 = manifestHash(a.envelope);
    expect(() => parseRehearsalAuthorization(a, m, manifestHash(m))).toThrow();
  },
);
test("declared tags alone never permit a consequential engine call or CLI intent", async () => {
  const manifest = rehearsalFixture(),
    calls = [];
  const engine = createRehearsalIntroduction({
    manifest,
    expectedSha256: manifestHash(manifest),
    aws: async (...args) => calls.push(args),
  });
  await expect(engine.run("fence")).rejects.toThrow(
    "Trusted evidence collector unavailable",
  );
  expect(calls).toEqual([]);
  const directory = mkdtempSync(join(tmpdir(), "chronote-rehearsal-test-"));
  try {
    const path = join(directory, "manifest.json");
    writeFileSync(path, JSON.stringify(manifest));
    const errors = [];
    expect(
      await runCli(
        ["fence", "--manifest", path, "--sha256", manifestHash(manifest)],
        { error: (value) => errors.push(JSON.parse(value)) },
      ),
    ).toBe(1);
    expect(errors).toEqual([
      {
        kind: "rehearsal_introduction_refused",
        action: "preserve_state_and_reconcile",
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { introductionFixture } from "../fixtures/deployment/productionIntroduction.js";
import { stateDigest } from "../../scripts/deployment/production-evidence.cjs";
test("strict rehearsal wrapper uses the same engine with its own validated session", async () => {
  const f = introductionFixture(
    marshall,
    unmarshall,
    stateDigest,
    rehearsalFixture(),
  );
  f.options.authorization = rehearsalAuthorization(f.m);
  const native = f.options.aws;
  f.options.aws = async (service, operation, input) =>
    service === "sts"
      ? {
          Account: f.m.binding.accountId,
          Arn: f.options.authorization.envelope.principalArn,
        }
      : native(service, operation, input);
  await createRehearsalIntroduction(f.options).run("fence");
  expect(f.isOwned()).toBe(true);
  expect(unmarshall(f.rows.get("PRODUCTION_INTRODUCTION")).stage).toBe(
    "fence_acknowledged",
  );
});

test("rejects an impossible extra task ARN path even with matching declared evidence", () => {
  const m = rehearsalFixture(),
    original = m.legacyTaskArn;
  m.legacyTaskArn = original.replace(
    "/" + m.cluster + "/",
    "/" + m.cluster + "/extra/",
  );
  m.resourceEvidence.find((entry) => entry.arn === original).arn =
    m.legacyTaskArn;
  expect(() => parseRehearsalManifest(m, manifestHash(m))).toThrow();
});
