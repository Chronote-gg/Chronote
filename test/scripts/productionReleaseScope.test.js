/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  needsPublication,
  publicationDecision,
  publishJobs,
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
  ".github/workflows/deploy.yml",
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
            { id: 1, head_sha: published, conclusion: "success" },
          ],
        }
      : [
          {
            jobs: publishJobs.map((name) => ({
              name,
              conclusion: path.includes("/runs/1/") ? "success" : "skipped",
            })),
          },
        ];
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
  expect(scope.needs).toBe("ci");
  expect(scope.permissions).toEqual({ actions: "read", contents: "read" });
  expect(scope["timeout-minutes"]).toBe(10);
  expect(scope.if).toBe("github.ref == 'refs/heads/master'");
  expect(scope.steps.find((step) => step.id === "manual")).toMatchObject({
    if: "github.event_name == 'workflow_dispatch'",
    run: expect.stringContaining("publish=true"),
  });
  expect(scope.steps.find((step) => step.id === "scope")?.if).toBe(
    "github.event_name == 'push'",
  );
  expect(workflow.jobs.ci.needs).toBeUndefined();
  expect(workflow.jobs.ci.if).toBe("github.ref == 'refs/heads/master'");
  expect(docs.needs).toEqual(["ci", "release-scope"]);
  expect(docs.if).toContain("needs.ci.result == 'success'");
  expect(docs.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(docs.if).toContain("needs.release-scope.outputs.publish != 'false'");
  expect(workflow.jobs.deploybackend.needs).toEqual(["ci", "deploy-docs"]);
  expect(workflow.jobs.deploybackend.if).toBe(
    "${{ !cancelled() && needs.ci.result == 'success' && needs.deploy-docs.result == 'success' }}",
  );
  expect(publishJobs).toEqual(
    ["deploy-docs", "deploybackend", "deploy-frontend"].map(
      (id) => workflow.jobs[id].name,
    ),
  );
});

test("finds the last release beyond the first page, past skips and pre-approval cancellations", () => {
  const published = "a".repeat(40);
  const earlierRuns = Array.from({ length: 20 }, (_, index) => ({
    id: index + 2,
    head_sha: "b".repeat(40),
    conclusion: "cancelled",
  }));
  const get = (path) => {
    if (path.includes("/workflows/")) {
      return {
        workflow_runs: path.endsWith("&page=1")
          ? earlierRuns
          : [{ id: 1, head_sha: published, conclusion: "success" }],
      };
    }
    const conclusion = path.includes("/runs/1/") ? "success" : "cancelled";
    return [
      {
        jobs: publishJobs
          .slice(0, 2)
          .map((name) => ({ name, conclusion, steps: [] })),
      },
      { jobs: [{ name: publishJobs[2], conclusion, steps: [] }] },
    ];
  };
  expect(
    publicationDecision("test/repo", "c".repeat(40), get, () => [
      "_infra/main.tf",
    ]),
  ).toMatchObject({
    before: published,
    publish: false,
  });
});

test("publishes a revert after an intervening run started publishing and failed", () => {
  const get = (path) =>
    path.includes("/workflows/")
      ? {
          workflow_runs: [
            { id: 2, head_sha: "b".repeat(40), conclusion: "failure" },
            { id: 1, head_sha: "a".repeat(40), conclusion: "success" },
          ],
        }
      : [
          {
            jobs: [
              {
                name: "Deploy Backend",
                conclusion: "failure",
                steps: [{ started_at: "2026-11-20T00:00:00Z" }],
              },
            ],
          },
        ];
  expect(
    publicationDecision("test/repo", "c".repeat(40), get, () => [
      "_infra/main.tf",
    ]).publish,
  ).toBe(true);
});

test("skips a stale push when master advances before publication", () => {
  const get = (path) =>
    path.endsWith("/git/ref/heads/master")
      ? { object: { sha: "d".repeat(40) } }
      : { workflow_runs: [] };
  expect(
    publicationDecision("test/repo", "c".repeat(40), get, undefined, true),
  ).toMatchObject({
    publish: false,
    superseded: true,
  });
});
