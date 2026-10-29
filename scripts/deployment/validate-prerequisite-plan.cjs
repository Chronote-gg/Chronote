"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { hasUnknown } = require("./terraform-meeting-update.cjs");

const targets = new Set([
  "aws_dynamodb_table.deployment_control_table",
  "aws_lb_target_group.api_spare_tg[0]",
  "aws_iam_role_policy.deployment_control",
  "aws_iam_policy.deployment_routing[0]",
]);

// Accepts only reads, no-ops and create/update at the scope's own addresses.
// `check` may inspect a target's change content; `requiredNoOp` names
// sensitive dependencies that must be present and unchanged.
function validateScopedPlan(plan, scope) {
  assert.ok(plan && Array.isArray(plan.resource_changes));
  const unchanged = new Set();
  const changes = [];
  for (const resource of plan.resource_changes) {
    assert.ok(
      resource &&
        typeof resource.address === "string" &&
        resource.address.length > 0,
    );
    assert.ok(resource.change && Array.isArray(resource.change.actions));
    assert.equal(resource.change.importing ?? null, null);
    assert.equal(resource.previous_address ?? null, null);
    assert.equal(resource.change.actions.length, 1);
    const action = resource.change.actions[0];
    if (resource.mode === "data") {
      assert.ok(action === "read" || action === "no-op");
      continue;
    }
    assert.equal(resource.mode, "managed");
    if (action === "no-op") {
      unchanged.add(resource.address);
      continue;
    }
    const allowed = scope.targets.get(resource.address);
    assert.ok(allowed && allowed.includes(action));
    scope.check?.(resource);
    changes.push({ address: resource.address, action });
  }
  for (const address of scope.requiredNoOp) assert.ok(unchanged.has(address));
  return { result: "accepted", changes };
}

// An in-place update may change only `changed`; every other field stays known and equal.
function assertOtherwiseUnchanged({ before, after, unknown }, changed) {
  const keys = [before, after, unknown].flatMap(Object.keys);
  for (const key of new Set(keys)) {
    if (changed.includes(key)) continue;
    assert.ok(!hasUnknown(unknown[key] ?? false));
    assert.deepEqual(after[key], before[key]);
  }
}

function validatePrerequisitePlan(plan) {
  const { result, changes } = validateScopedPlan(plan, {
    targets: new Map([...targets].map((t) => [t, ["create", "update"]])),
    requiredNoOp: ["aws_kms_key.app_general"],
  });
  return { result, existingKey: "no-op", changes };
}
function runCli(validate, refusal) {
  try {
    process.stdout.write(
      JSON.stringify(validate(JSON.parse(readFileSync(0, "utf8")))) + "\n",
    );
  } catch {
    process.stderr.write(refusal);
    process.exitCode = 1;
  }
}
module.exports = {
  validatePrerequisitePlan,
  validateScopedPlan,
  assertOtherwiseUnchanged,
  runCli,
  targets,
};
if (require.main === module)
  runCli(
    validatePrerequisitePlan,
    "Deployment prerequisite plan rejected: invalid action evidence or changes outside the four-target scope.\n",
  );
