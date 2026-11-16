/** @jest-environment node */
import { readFileSync } from "node:fs";
import { expect, test } from "@jest/globals";
import { deployVariableNames } from "../../scripts/deployment/validate-runtime-plan.cjs";

const source = readFileSync("_infra/production-deployment.tf", "utf8").replace(
  /\r\n/g,
  "\n",
);
// Keys of a `name = {` or `name = ... merge({` map literal in the locals block.
const mapKeys = (local) => {
  const body = source.match(
    new RegExp(String.raw`\n  ${local} = [^\n]*\{\n([\s\S]*?)\n  \}`),
  )?.[1];
  expect(body).toBeDefined();
  return [...body.matchAll(/^ {4}([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
};

// The runtime validator refuses any deploy variable it does not list, so a
// variable added to Terraform without the allowlist refuses the real plan.
test("the validator allows exactly the variables Terraform writes to production-deploy", () => {
  const terraform = [
    ...mapKeys("production_deploy_variables"),
    ...mapKeys("production_deploy_optional_variables"),
  ];
  expect(terraform).toContain("ECS_LOG_GROUP");
  expect(new Set(terraform).size).toBe(terraform.length);
  expect([...deployVariableNames].sort()).toEqual([...terraform].sort());
});
