"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const environment = __dirname.includes("sandbox-bootstrap")
  ? "sandbox"
  : "production";
const prefix =
  environment === "sandbox" ? "meeting-notes-sandbox" : "meeting-notes-prod";
const {
  validateArtifactIamBootstrapUpdate: inspect,
} = require("./verify-plan.cjs");
function candidate() {
  const fixture = (n) =>
    JSON.parse(readFileSync(join(__dirname, "tests/fixtures", n), "utf8"));
  const plan = fixture("create-plan.json"),
    binding = fixture("reviewed-binding.json");
  binding.variables.artifact_app_kms_key_arn =
    "arn:aws:kms:us-east-1:123456789012:key/22222222-2222-4222-8222-222222222222";
  binding.variables.artifact_transcripts_bucket = `${prefix}-transcripts-123456789012`;
  for (const [k, v] of Object.entries(binding.variables))
    plan.variables[k] = { value: v };
  for (const r of plan.resource_changes) {
    if (r.mode !== "managed") continue;
    r.change.before = structuredClone(r.change.after);
    r.change.after_unknown = {};
    r.change.actions = ["no-op"];
  }
  const policy = plan.resource_changes.find(
    (r) => r.type === "aws_iam_role_policy",
  );
  if (environment === "production") {
    const old = JSON.parse(policy.change.before.policy);
    old.Statement.push({
      Sid: "EvidenceConditionalCreate",
      Effect: "Allow",
      Action: "s3:PutObject",
      Resource: "arn:aws:s3:::fixture/terraform/production/*",
      Condition: { StringEquals: { "s3:if-none-match": "*" } },
    });
    policy.change.before.policy = policy.change.after.policy =
      JSON.stringify(old);
  }
  const role = plan.resource_changes.find((r) => r.type === "aws_iam_role");
  role.change.before.inline_policy = role.change.after.inline_policy = [
    { name: policy.change.after.name, policy: policy.change.before.policy },
  ];
  binding.previousRolePolicySha256 = hash(policy.change.before.policy);
  if (environment === "sandbox")
    binding.bucketOwnerCanonicalId = "a".repeat(64);
  // Independent exact statement fixture is supplied by the source contract under test.
  const {
    artifactIamBootstrapStatements,
  } = require("../../scripts/deployment/artifact-iam-bootstrap.cjs");
  const doc = JSON.parse(policy.change.after.policy);
  doc.Statement.push(
    ...artifactIamBootstrapStatements(binding.variables, environment),
  );
  policy.change.after.policy = JSON.stringify(doc);
  policy.change.actions = ["update"];
  binding.policySha256.role = hash(policy.change.after.policy);
  return { plan, binding, policy };
}
test("accepts only the artifact IAM bootstrap delta", () => {
  const c = candidate();
  assert.equal(inspect(c.plan, c.binding), true);
});
for (const fault of [
  "foreign-resource",
  "pruning",
  "deleted-before",
  "capture-condition",
  "trust",
  "hash",
  "unknown",
  "history-write",
  "capture-retention",
]) {
  test(`refuses ${fault}`, () => {
    const c = candidate(),
      doc = JSON.parse(c.policy.change.after.policy);
    if (fault === "foreign-resource")
      doc.Statement.find((s) => s.Sid === "ArtifactPolicyVersions").Resource +=
        "-other";
    if (fault === "pruning")
      doc.Statement.find((s) => s.Sid === "ArtifactPolicyVersions").Action.push(
        "iam:DeletePolicyVersion",
      );
    if (fault === "deleted-before") doc.Statement.shift();
    if (fault === "capture-condition") {
      const s = doc.Statement.find(
        (s) => [].concat(s.Action).includes("s3:PutObject") && s.Condition,
      );
      delete s.Condition;
    }
    if (fault === "trust") {
      const r = c.plan.resource_changes.find((r) => r.type === "aws_iam_role");
      r.change.actions = ["update"];
      r.change.after.assume_role_policy = "{}";
    }
    if (fault === "hash") c.binding.previousRolePolicySha256 = "0".repeat(64);
    if (fault === "unknown") c.policy.change.after_unknown.policy = true;
    if (fault === "history-write")
      doc.Statement.push({
        Sid: "Other",
        Effect: "Allow",
        Action: "dynamodb:PutItem",
        Resource: "*",
      });
    if (fault === "capture-retention") {
      const r = c.plan.resource_changes.find((r) => r.type === "aws_s3_bucket");
      r.change.actions = ["update"];
      r.change.after.lifecycle_rule = [{ expiration: [{ days: 1 }] }];
    }
    c.policy.change.after.policy = JSON.stringify(doc);
    c.binding.policySha256.role = hash(c.policy.change.after.policy);
    assert.throws(() => inspect(c.plan, c.binding));
  });
}

test(
  "rendered mocked Terraform policy matches the independent artifact grant contract",
  { skip: !process.env.ARTIFACT_BOOTSTRAP_MOCK_JSONL },
  () => {
    const events = readFileSync(
      process.env.ARTIFACT_BOOTSTRAP_MOCK_JSONL,
      "utf8",
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
    const plans = events.filter((e) => e.type === "test_plan");
    const base = plans.find((e) => e["@testrun"] === "enabled").test_plan;
    const artifact = plans.find(
      (e) => e["@testrun"] === "artifact_iam",
    ).test_plan;
    const policy = (p) =>
      JSON.parse(
        p.resource_changes.find((r) => r.type === "aws_iam_role_policy").change
          .after.policy,
      );
    const v = candidate().binding.variables;
    const {
      artifactIamBootstrapStatements,
    } = require("../../scripts/deployment/artifact-iam-bootstrap.cjs");
    const expected = policy(base);
    expected.Statement.push(...artifactIamBootstrapStatements(v, environment));
    const {
      canonical,
    } = require("../../scripts/deployment/terraform-meeting-update.cjs");
    assert.deepEqual(canonical(policy(artifact)), canonical(expected));
    assert.equal(
      artifact.resource_changes.filter((r) => r.mode === "managed").length,
      8,
    );
    const raw = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "../../test/fixtures/deployment/artifactIamPermissions.json",
        ),
        "utf8",
      ),
    )[environment];
    const backend = `arn:aws:iam::123456789012:role/${prefix}-github-deploy`;
    const roleReads = raw.find((s) => s.Sid === "ArtifactRoleMetadata");
    for (const action of roleReads.Action)
      assert.ok(
        policy(base).Statement.some(
          (s) =>
            s.Effect === "Allow" &&
            !s.Condition &&
            [].concat(s.Action).includes(action) &&
            [].concat(s.Resource).includes(backend),
        ),
        "Backend read grant must already exist",
      );
    roleReads.Resource = roleReads.Resource.filter((r) => r !== backend);
    const pairs = (statements) =>
      [
        ...new Set(
          statements.flatMap((s) =>
            [].concat(s.Action).flatMap((a) =>
              []
                .concat(s.Resource)
                .filter((r) => r.split(":")[2] === a.split(":")[0])
                .map((r) => `${a}|${r}`),
            ),
          ),
        ),
      ].sort();
    const delta = policy(artifact).Statement.filter((s) =>
      s.Sid.startsWith("Artifact"),
    );
    assert.deepEqual(
      pairs(delta),
      pairs(raw),
      "Compaction changed a service-supported action/resource pair",
    );
    const {
      inlinePolicySize,
    } = require("../../scripts/deployment/artifact-iam-bootstrap.cjs");
    const size = inlinePolicySize(JSON.stringify(policy(artifact)));
    if (environment === "sandbox") assert.ok(size <= 10240);
    else
      assert.ok(size > 10240, "Production quota blocker must remain visible");
  },
);

test("aggregate quota excludes whitespace and checks the inclusive boundary", () => {
  const {
    assertInlineQuota,
    inlinePolicySize,
  } = require("../../scripts/deployment/artifact-iam-bootstrap.cjs");
  const small = JSON.stringify({ Version: "2012-10-17", Statement: [] });
  const fill = (n) => '{"x":"' + "a".repeat(n - 8) + '"}';
  assert.equal(inlinePolicySize(" \n\t" + small + "\r"), small.length);
  assert.equal(assertInlineQuota([{ policy: fill(10240) }]), 10240);
  assert.throws(
    () => assertInlineQuota([{ policy: fill(10240) }, { policy: small }]),
    /HOLD/,
  );
  assert.throws(() => assertInlineQuota([{ policy: fill(10241) }]), /HOLD/);
});

for (const fault of [
  "missing-readback",
  "stale-readback",
  "extra-inline-quota",
])
  test(`aggregate guard refuses ${fault}`, () => {
    const c = candidate(),
      role = c.plan.resource_changes.find((r) => r.type === "aws_iam_role");
    if (fault === "missing-readback") delete role.change.after.inline_policy;
    if (fault === "stale-readback")
      role.change.after.inline_policy[0].policy = "{}";
    if (fault === "extra-inline-quota")
      role.change.after.inline_policy.push({
        name: "other",
        policy: JSON.stringify({ x: "a".repeat(10240) }),
      });
    assert.throws(() => inspect(c.plan, c.binding), /HOLD/);
  });
