"use strict";
const assert = require("node:assert/strict");
const {
  validateScopedPlan,
  runCli,
} = require("./validate-prerequisite-plan.cjs");

const policy = "aws_iam_policy.transcripts_s3_policy";
const artifactPreservationTargets = new Map([[policy, ["update"]]]);
const policyName = "meeting-notes-prod-bot-transcripts-s3-policy";
// The task roles' complete transcripts bucket grant, including the versioned
// read that artifact preservation needs. Nothing else may appear.
const allowedActions = [
  "s3:AbortMultipartUpload",
  "s3:GetObject",
  "s3:GetObjectVersion",
  "s3:ListBucket",
  "s3:PutObject",
];
const bucketArn = /^arn:aws:s3:::[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const sorted = (values) => [...values].sort();

function document(value) {
  assert.equal(typeof value, "string");
  const parsed = JSON.parse(value);
  assert.equal(parsed.Version, "2012-10-17");
  const [statement, ...extra] = parsed.Statement;
  assert.equal(extra.length, 0, "the policy holds exactly one statement");
  return statement;
}

// One bucket, named twice: the bucket itself and every object in it.
function resources(statement) {
  const [arn, objects, ...extra] = statement.Resource;
  assert.equal(extra.length, 0);
  assert.match(arn, bucketArn);
  assert.equal(objects, `${arn}/*`);
  return [arn, objects];
}

// The update may change the action list and nothing else: not the bucket it
// grants on, not the effect, and never to a wildcard or a deny.
function checkPolicy({ before, after }) {
  assert.ok(before && after);
  assert.equal(after.name, policyName);
  assert.equal(after.name, before.name);
  assert.equal(after.path, before.path);
  const current = document(after.policy);
  assert.equal(current.Effect, "Allow");
  assert.ok(!("NotAction" in current) && !("NotResource" in current));
  assert.ok(!("Condition" in current));
  assert.deepEqual(sorted(current.Action), allowedActions);
  assert.deepEqual(resources(current), resources(document(before.policy)));
}

// A single-target scope: the policy now builds its bucket ARN from the bucket
// name instead of the bucket resource, so nothing else is in the graph.
function assertClosure(plan) {
  for (const { address, mode } of plan.resource_changes)
    assert.ok(
      mode !== "managed" || address === policy,
      `${address} is outside the artifact-preservation closure`,
    );
}

function validateArtifactPreservationPlan(plan, { accountId, environment }) {
  assert.match(accountId, /^\d{12}$/);
  assert.equal(environment, "production");
  assert.ok(plan && Array.isArray(plan.resource_changes));
  assertClosure(plan);
  const result = validateScopedPlan(plan, {
    targets: artifactPreservationTargets,
    requiredNoOp: [],
    check: ({ change }) => checkPolicy(change),
  });
  // An already applied or absent policy change is not this scope's plan.
  assert.deepEqual(result.changes, [{ address: policy, action: "update" }]);
  return result;
}
module.exports = {
  validateArtifactPreservationPlan,
  artifactPreservationTargets,
};
if (require.main === module)
  runCli(
    (plan) =>
      validateArtifactPreservationPlan(plan, {
        accountId: process.argv[2],
        environment: process.argv[3],
      }),
    "Artifact preservation plan rejected: invalid action evidence, a changed bucket or grant, or changes outside the transcripts policy scope.\n",
  );
