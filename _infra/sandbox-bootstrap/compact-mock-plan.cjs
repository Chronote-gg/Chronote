"use strict";
const { readFileSync } = require("node:fs");
const { ok } = require("node:assert/strict");
function compactMockPlan(raw) {
  const candidates = raw
    .trim()
    .split(/\r?\n/)
    .map((row) => JSON.parse(row.replace(/^\uFEFF/, "")));
  const selected = candidates.filter(
    (item) => item.type === "test_plan" && item["@testrun"] === "enabled",
  );
  ok(selected.length === 1, "expected exactly one enabled mock-plan event");
  const result = structuredClone(selected[0]);
  ok(
    Array.isArray(result.test_plan.resource_changes),
    "native changes missing",
  );
  delete result.test_plan.provider_schemas;
  return result;
}
module.exports = { compactMockPlan };
if (require.main === module) {
  ok(
    process.argv.length === 3,
    "usage: node compact-mock-plan.cjs MOCK_OUTPUT_JSONL",
  );
  process.stdout.write(
    JSON.stringify(compactMockPlan(readFileSync(process.argv[2], "utf8"))) +
      "\n",
  );
}
