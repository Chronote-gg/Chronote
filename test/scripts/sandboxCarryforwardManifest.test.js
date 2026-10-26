/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { bindingHash } from "../../scripts/deployment/continue-sandbox.cjs";
import { readCarryforwardManifest } from "../../scripts/deployment/carryforward-manifest.cjs";
function fixture() {
  const manifest = {
    version: 1,
    kind: "sandbox_historical_carryforward",
    operationId: "0e46f154-2ad7-482d-8930-f045fbfd197b",
    policy: "normal_protected_deployments_with_unresolved_history",
    operatorExclusion: "exclusive_approved_writer_window",
    accountId: "123456789012",
    region: "us-east-1",
    sourceCommit: "a".repeat(40),
    imageSourceCommit: "b".repeat(40),
    image:
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/fixture-sandbox@sha256:" +
      "c".repeat(64),
    templateArn:
      "arn:aws:ecs:us-east-1:123456789012:task-definition/fixture-sandbox:30",
    preparedDefinitionSha256: "d".repeat(64),
    controlSha256: "e".repeat(64),
    recoverySha256: "f".repeat(64),
    originalRunToken: "900-1",
    approveBefore: 2000,
  };
  const env = {
    EXPECTED_ACCOUNT_ID: manifest.accountId,
    AWS_REGION: manifest.region,
    GITHUB_SHA: manifest.sourceCommit,
    GITHUB_RUN_ID: "901",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: "Chronote-gg/Chronote",
  };
  const bind = () => {
    env.CARRYFORWARD_MANIFEST_JSON = JSON.stringify(manifest);
    env.CARRYFORWARD_MANIFEST_SHA256 = bindingHash(manifest);
  };
  bind();
  return { manifest, env, bind };
}
test("the exact private approval binds tooling source independently from existing runtime image provenance", () => {
  const f = fixture();
  expect(readCarryforwardManifest(f.env, () => 1000)).toEqual({
    manifest: f.manifest,
    hash: bindingHash(f.manifest),
    runToken: "901-1",
  });
  f.env.CARRYFORWARD_MANIFEST_JSON = JSON.stringify(f.manifest, null, 2);
  expect(readCarryforwardManifest(f.env, () => 1000).hash).toBe(
    bindingHash(f.manifest),
  );
});

test.each(["900-2", "900-12"])(
  "a historical rerun source %s remains eligible with a new attempt1 execution",
  (token) => {
    const f = fixture();
    f.manifest.originalRunToken = token;
    f.bind();
    expect(
      readCarryforwardManifest(f.env, () => 1000).manifest.originalRunToken,
    ).toBe(token);
    f.env.GITHUB_RUN_ATTEMPT = "2";
    expect(() => readCarryforwardManifest(f.env, () => 1000)).toThrow();
  },
);
test.each([
  "hash",
  "source",
  "account",
  "region",
  "repository",
  "attempt",
  "run",
  "expired",
  "too_long",
  "extra",
  "policy",
])("manifest refuses %s before provider operations", (scenario) => {
  const f = fixture();
  if (scenario === "hash") f.env.CARRYFORWARD_MANIFEST_SHA256 = "0".repeat(64);
  if (scenario === "source") f.env.GITHUB_SHA = "0".repeat(40);
  if (scenario === "account") f.env.EXPECTED_ACCOUNT_ID = "000000000000";
  if (scenario === "region") f.env.AWS_REGION = "us-west-2";
  if (scenario === "repository") f.env.GITHUB_REPOSITORY = "foreign/repo";
  if (scenario === "attempt") f.env.GITHUB_RUN_ATTEMPT = "2";
  if (scenario === "run") f.env.GITHUB_RUN_ID = "not-a-run";
  if (scenario === "expired") {
    f.manifest.approveBefore = 999;
    f.bind();
  }
  if (scenario === "too_long") {
    f.manifest.approveBefore = 100000;
    f.bind();
  }
  if (scenario === "extra") {
    f.manifest.notes = "PRIVATE";
    f.bind();
  }
  if (scenario === "policy") {
    f.manifest.policy = "settle_old_work";
    f.bind();
  }
  expect(() => readCarryforwardManifest(f.env, () => 1000)).toThrow();
});
