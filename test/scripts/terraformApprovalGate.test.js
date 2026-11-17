/** @jest-environment node */
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@jest/globals";

// A mocked terraform test cannot seed the hand-set reviewer into state (mock
// overrides only fill computed attributes), so this checks the source shape.
const gateAttributes = [
  "reviewers",
  "deployment_branch_policy",
  "can_admins_bypass",
  "prevent_self_review",
  "wait_timer",
];
const environments = readdirSync("_infra")
  .filter((name) => name.endsWith(".tf"))
  .flatMap((name) =>
    [
      ...readFileSync(`_infra/${name}`, "utf8")
        .replace(/\r\n/g, "\n")
        .matchAll(
          /^resource "github_repository_environment" "(\w+)" \{\n([\s\S]*?)\n\}$/gm,
        ),
    ].map(([, label, body]) => ({ label, body })),
  );

test("the root manages the reviewed environment and the reviewer-free deploy one", () => {
  expect(environments.map((e) => e.label).sort()).toEqual([
    "production_deploy",
    "repo_env",
  ]);
});

test("a plan never changes the approval gate of a reviewed environment", () => {
  for (const { label, body } of environments) {
    if (label === "production_deploy") continue;
    const ignored = body.match(/ignore_changes\s*=\s*\[([^\]]*)\]/)?.[1];
    expect(ignored?.split(",").map((a) => a.trim())).toEqual(gateAttributes);
    for (const attribute of gateAttributes)
      expect(body).not.toMatch(new RegExp(`^\\s*${attribute}\\s*[={]`, "m"));
  }
});

test("production-deploy declares its whole gate: no reviewer, no bypass, master only", () => {
  const { body } = environments.find((e) => e.label === "production_deploy");
  expect(body).toMatch(/can_admins_bypass\s*=\s*false/);
  expect(body).toMatch(/custom_branch_policies\s*=\s*true/);
  expect(body).not.toMatch(/ignore_changes/);
});
