"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
function compactMockPlan(text) {
  const event = text
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line.replace(/^\uFEFF/, "")))
    .find(
      (value) => value.type === "test_plan" && value["@testrun"] === "enabled",
    );
  assert.ok(event, "missing enabled mock plan");
  const { resource_changes, output_changes } = event.test_plan;
  assert.ok(Array.isArray(resource_changes));
  return {
    type: "test_plan",
    "@testrun": "enabled",
    test_plan: { resource_changes, output_changes },
  };
}
if (require.main === module) {
  assert.equal(
    process.argv.length,
    3,
    "usage: node compact-mock-plan.cjs mock-output.jsonl",
  );
  process.stdout.write(
    JSON.stringify(compactMockPlan(readFileSync(process.argv[2], "utf8"))) +
      "\n",
  );
}
module.exports = { compactMockPlan };
