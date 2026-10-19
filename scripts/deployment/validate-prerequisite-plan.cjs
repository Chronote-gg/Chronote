"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const targets = new Set([
  "aws_dynamodb_table.deployment_control_table",
  "aws_lb_target_group.api_spare_tg[0]",
  "aws_iam_role_policy.deployment_control",
  "aws_iam_policy.deployment_routing[0]",
]);

function validatePrerequisitePlan(plan) {
  assert.ok(plan && Array.isArray(plan.resource_changes));
  let keyUnchanged = false;
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
      if (resource.address === "aws_kms_key.app_general") keyUnchanged = true;
      continue;
    }
    assert.ok(
      targets.has(resource.address) &&
        (action === "create" || action === "update"),
    );
    changes.push({ address: resource.address, action });
  }
  assert.ok(keyUnchanged);
  return { result: "accepted", existingKey: "no-op", changes };
}
module.exports = { validatePrerequisitePlan };
if (require.main === module)
  try {
    process.stdout.write(
      JSON.stringify(
        validatePrerequisitePlan(JSON.parse(readFileSync(0, "utf8"))),
      ) + "\n",
    );
  } catch {
    process.stderr.write(
      "Deployment prerequisite plan rejected: invalid action evidence or changes outside the four-target scope.\n",
    );
    process.exitCode = 1;
  }
