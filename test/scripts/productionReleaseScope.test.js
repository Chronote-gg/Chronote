/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  needsPublication,
  publicationDecision,
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

test("keeps publication when the published baseline or diff is unavailable", () => {
  expect(needsPublication([])).toBe(true);
  expect(
    publicationDecision("test/repo", "f".repeat(40), () => ({
      workflow_runs: [],
    })).publish,
  ).toBe(true);
  expect(
    publicationDecision("test/repo", "f".repeat(40), () => {
      throw Error("Unavailable");
    }).publish,
  ).toBe(true);
});

test("does not treat an infra-only skip as a release baseline", () => {
  const published = "a".repeat(40);
  const after = "c".repeat(40);
  const get = (path) =>
    path.includes("/workflows/")
      ? {
          workflow_runs: [
            { id: 2, head_sha: "b".repeat(40) },
            { id: 1, head_sha: published },
          ],
        }
      : {
          jobs: ["Deploy Docs", "Deploy Backend", "Deploy Frontend"].map(
            (name) => ({
              name,
              conclusion: path.includes("/runs/1/") ? "success" : "skipped",
            }),
          ),
        };
  const result = publicationDecision(
    "test/repo",
    after,
    get,
    (before, head) => {
      expect(before).toBe(published);
      expect(head).toBe(after);
      return ["src/bot.ts", "_infra/main.tf"];
    },
  );
  expect(result).toMatchObject({ before: published, publish: true });
});

test("keeps master CI, manual release and Docs-before-backend ordering", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const scope = workflow.jobs["release-scope"];
  const docs = workflow.jobs["deploy-docs"];
  expect(workflow.on.workflow_dispatch).toBeDefined();
  expect(scope.environment).toBeUndefined();
  expect(scope.permissions).toEqual({ actions: "read", contents: "read" });
  expect(scope["timeout-minutes"]).toBe(10);
  expect(scope.if).toContain("github.event_name == 'push'");
  expect(workflow.jobs.ci.needs).toBeUndefined();
  expect(workflow.jobs.ci.if).toBe("github.ref == 'refs/heads/master'");
  expect(docs.needs).toEqual(["ci", "release-scope"]);
  expect(docs.if).toContain("needs.ci.result == 'success'");
  expect(docs.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(docs.if).toContain("needs.release-scope.outputs.publish != 'false'");
  expect(workflow.jobs.deploybackend.needs).toEqual(["ci", "deploy-docs"]);
});
