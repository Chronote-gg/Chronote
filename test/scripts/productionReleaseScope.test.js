/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  needsPublication,
  shouldPublish,
} from "../../scripts/deployment/production-release-scope.cjs";

test("skips the Terraform-only Grafana retirement and repository operations docs", () => {
  expect(
    needsPublication([
      "_infra/observability.tf",
      "_infra/lambda/grafana_token_rotation/handler.py",
      "_infra_state_mgmt/main.tf",
      "README.md",
      "docs/engineering/infrastructure.md",
      "docs/terraform-delivery.md",
      "scripts/deployment/terraform-runs.cjs",
      "scripts/deployment/terraform-tfvars.py",
      "test/scripts/terraformRuns.test.js",
    ]),
  ).toBe(false);
});

test.each([
  "src/bot.ts",
  "apps/docs-site/docs/whats-new.md",
  "prompts/notes.md",
  "yarn.lock",
])(
  "keeps publication for %s mixed into a large infrastructure change",
  (file) =>
    expect(
      needsPublication([
        ...Array.from(
          { length: 310 },
          (_, index) => "_infra/example-" + index + ".tf",
        ),
        file,
      ]),
    ).toBe(true),
);

test("keeps publication when the push diff is empty or unavailable", () => {
  expect(needsPublication([])).toBe(true);
  expect(shouldPublish("missing", "f".repeat(40))).toBe(true);
  expect(shouldPublish("0".repeat(40), "f".repeat(40))).toBe(true);
});

test("manual release and Docs-before-backend ordering remain in place", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
  expect(workflow.on.workflow_dispatch).toBeDefined();
  expect(workflow.jobs["release-scope"].environment).toBeUndefined();
  expect(workflow.jobs["release-scope"].permissions).toBeUndefined();
  expect(workflow.jobs.ci.needs).toEqual(["release-scope"]);
  expect(workflow.jobs["release-scope"].if).toContain(
    "github.event_name == 'push'",
  );
  expect(workflow.jobs.ci.if).toContain(
    "github.event_name == 'workflow_dispatch'",
  );
  expect(workflow.jobs.ci.if).toContain(
    "needs.release-scope.outputs.publish != 'false'",
  );
  expect(workflow.jobs.deploybackend.needs).toEqual(["ci", "deploy-docs"]);
});
