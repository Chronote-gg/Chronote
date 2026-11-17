/** @jest-environment node */
import { readFileSync } from "node:fs";
import { expect, test } from "@jest/globals";
import { parse } from "yaml";
import inputs from "../../scripts/deployment/deploy-environment-inputs.json";

const deployJobs = [
  "deploybackend",
  "deploy-frontend",
  "deploy-docs",
  "promote-prompts",
  "sync-openai-connection",
];
const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
const read = (kind) =>
  new Set(
    deployJobs.flatMap((name) =>
      [
        ...JSON.stringify(workflow.jobs[name]).matchAll(
          new RegExp(`${kind}\\.([A-Z][A-Z0-9_]*)`, "g"),
        ),
      ].map((match) => match[1]),
    ),
  );

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
const terraformWritten = [
  ...mapKeys("production_deploy_variables"),
  ...mapKeys("production_deploy_optional_variables"),
];

// Switching deploys to production-deploy only works if every input the deploy
// jobs read is written there by Terraform, copied by hand, or repo-level.
test("every variable the deploy jobs read has a documented source", () => {
  const documented = new Set([
    ...terraformWritten,
    ...inputs.repositoryLevel.variables,
    ...inputs.handCopied.variables,
    ...inputs.unsetDefaultsApply.variables,
  ]);
  for (const name of read("vars"))
    expect([name, documented.has(name)]).toEqual([name, true]);
});

test("every secret the deploy jobs read has a documented source", () => {
  const documented = new Set([
    ...inputs.repositoryLevel.secrets,
    ...inputs.handCopied.secrets,
  ]);
  for (const name of read("secrets"))
    expect([name, documented.has(name)]).toEqual([name, true]);
});

test("the documented lists name only inputs the deploy jobs read", () => {
  const used = new Set([...read("vars"), ...read("secrets")]);
  for (const list of [
    inputs.repositoryLevel.variables,
    inputs.repositoryLevel.secrets,
    inputs.handCopied.variables,
    inputs.handCopied.secrets,
    inputs.unsetDefaultsApply.variables,
  ])
    for (const name of list)
      expect([name, used.has(name)]).toEqual([name, true]);
});

test("the switch procedure names every hand-copied input", () => {
  const procedure = readFileSync("docs/deployment.md", "utf8");
  for (const name of [
    ...inputs.handCopied.variables,
    ...inputs.handCopied.secrets,
  ])
    expect(procedure).toContain(`\`${name}\``);
  expect(procedure).toContain(
    "scripts/deployment/deploy-environment-inputs.json",
  );
});
