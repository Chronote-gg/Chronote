/** @jest-environment node */
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { introductionFixture } from "../fixtures/deployment/productionIntroduction.js";
import { stateDigest } from "../../scripts/deployment/production-evidence.cjs";
import { manifestHash } from "../../scripts/deployment/sandbox-manifest.cjs";
import { test, expect, jest } from "@jest/globals";
import {
  bindProposal,
  executeProposal,
  runCli,
} from "../../scripts/deployment/production-workflow.cjs";
import { createProductionIntroduction } from "../../scripts/deployment/introduce-production.cjs";
import { assertProductionIdentity } from "../../scripts/deployment/assert-production-identity.cjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function fixture() {
  const f = introductionFixture(marshall, unmarshall, stateDigest);
  return {
    ...f,
    context: {
      phase: "fence",
      operationId: f.m.binding.operationId,
      runId: "123",
      runAttempt: "1",
      sourceSha: f.m.binding.sourceSha,
      repository: f.m.sourceRepository,
      ref: "refs/heads/master",
      accountId: f.m.binding.accountId,
      roleArn: f.m.deploymentRoleArn,
    },
  };
}
test("read-only bind freezes the complete exact-run envelope without a write", async () => {
  const f = fixture();
  const result = await bindProposal(f.options, f.context);
  expect(result.envelope).toEqual({
    kind: "production-phase",
    manifestSha256: f.options.expectedSha256,
    operationId: f.context.operationId,
    phase: "fence",
    runId: "123",
    runAttempt: 1,
    principalArn: f.options.authorization.envelope.principalArn,
    sourceSha: f.context.sourceSha,
    predecessorSha256: null,
    validUntil: 5000,
    recovery: null,
  });
  expect(result.sha256).toBe(manifestHash(result.envelope));
  expect(f.writes).toEqual([]);
});
test.each([
  "runAttempt",
  "sourceSha",
  "repository",
  "ref",
  "operationId",
  "roleArn",
  "accountId",
  "phase",
])("bind rejects changed %s before provider calls", async (field) => {
  const f = fixture();
  f.context[field] = "wrong";
  f.options.aws = jest.fn();
  await expect(bindProposal(f.options, f.context)).rejects.toThrow();
  expect(f.options.aws).not.toHaveBeenCalled();
});
test("bind observes and hashes the complete current predecessor", async () => {
  const f = fixture();
  await createProductionIntroduction(f.options).run("fence");
  f.authorize("drain");
  f.context.phase = "drain";
  const writes = f.writes.length;
  const result = await bindProposal(f.options, f.context);
  expect(result.envelope.predecessorSha256).toBe(
    unmarshall(f.rows.get("PRODUCTION_INTRODUCTION")).receiptSha256,
  );
  expect(f.writes).toHaveLength(writes);
});
test("valid envelope reaches the explicit missing post-bind authority boundary without intent or provider writes", async () => {
  const f = fixture();
  const proposal = await bindProposal(f.options, f.context);
  const approval = {
    envelope: proposal.envelope,
    expectedSha256: proposal.sha256,
    bindSha256: proposal.sha256,
  };
  await expect(executeProposal(f.options, f.context, approval)).rejects.toThrow(
    "Post-bind human authority unavailable",
  );
  expect(f.writes).toEqual([]);
});
test.each([
  "body",
  "expected",
  "bind",
  "run",
  "predecessor",
  "expired",
  "absent",
])("rejects %s approval before the authority boundary", async (change) => {
  const f = fixture();
  const proposal = await bindProposal(f.options, f.context);
  let approval = {
    envelope: proposal.envelope,
    expectedSha256: proposal.sha256,
    bindSha256: proposal.sha256,
  };
  if (change === "body") approval.envelope.phase = "activate";
  if (change === "expected") approval.expectedSha256 = "0".repeat(64);
  if (change === "bind") approval.bindSha256 = "0".repeat(64);
  if (change === "run") f.context.runId = "124";
  if (change === "predecessor")
    await createProductionIntroduction(f.options).run("fence");
  if (change === "expired") f.options.now = () => 5001;
  if (change === "absent") approval = undefined;
  const before = f.writes.length;
  await expect(
    executeProposal(f.options, f.context, approval),
  ).rejects.not.toThrow("Post-bind human authority unavailable");
  expect(f.writes).toHaveLength(before);
});

test.each(["account", "role", "session", "sandbox"])(
  "exact production identity rejects %s substitution",
  (change) => {
    const f = fixture();
    const env = {
      EXPECTED_ACCOUNT_ID: f.m.binding.accountId,
      EXPECTED_ROLE_ARN: f.m.deploymentRoleArn,
      EXPECTED_SESSION_NAME: "chronote-production-123-1",
    };
    const actor = {
      Account: f.m.binding.accountId,
      Arn: f.options.authorization.envelope.principalArn,
    };
    expect(() => assertProductionIdentity(actor, env)).not.toThrow();
    if (change === "account") actor.Account = "999999999999";
    if (change === "role")
      actor.Arn = actor.Arn.replace("chronote-github", "foreign-github");
    if (change === "session") actor.Arn += "-other";
    if (change === "sandbox")
      env.EXPECTED_ROLE_ARN = env.EXPECTED_ROLE_ARN.replace(
        "chronote-github",
        "chronote-sandbox-github",
      );
    expect(() => assertProductionIdentity(actor, env)).toThrow();
  },
);
test("CLI refuses reruns with only sanitized output and saves private inputs locally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "production-workflow-"));
  const f = fixture(),
    output = { log: jest.fn(), error: jest.fn() };
  try {
    expect(
      await runCli(
        "bind",
        {
          RUNNER_TEMP: directory,
          PRODUCTION_INTRODUCTION_MANIFEST: JSON.stringify(f.m),
          INTRODUCTION_MANIFEST_SHA256: f.options.expectedSha256,
          INTRODUCTION_PHASE: "fence",
          INTRODUCTION_OPERATION_ID: f.context.operationId,
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_SHA: f.context.sourceSha,
          GITHUB_REPOSITORY: f.context.repository,
          GITHUB_REF: f.context.ref,
          EXPECTED_ACCOUNT_ID: f.context.accountId,
          EXPECTED_ROLE_ARN: f.context.roleArn,
        },
        output,
      ),
    ).toBe(1);
    expect(output.log).not.toHaveBeenCalled();
    expect(output.error).toHaveBeenCalledWith(
      JSON.stringify({
        kind: "production_introduction_refused",
        action: "preserve_state_and_reconcile",
      }),
    );
    expect(
      JSON.parse(
        readFileSync(
          join(directory, "production-introduction", "manifest.json"),
          "utf8",
        ),
      ),
    ).toEqual(f.m);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
