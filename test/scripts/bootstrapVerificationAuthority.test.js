/** @jest-environment node */
import { readFileSync } from "node:fs";
import { test, expect } from "@jest/globals";
import { load } from "js-yaml";
import { verifyAuthority } from "../../scripts/deployment/bootstrap-verification-authority.cjs";
import {
  nativeEnvironment,
  nativeBranchPolicies,
} from "../fixtures/deployment/terraformWorkflow.js";
const identity = { runId: "42", sourceSha: "a".repeat(40) };
function fixture() {
  const environment = nativeEnvironment();
  environment.id = 77;
  environment.protection_rules[0].prevent_self_review = false;
  environment.protection_rules[0].reviewers[0].reviewer.id = 2165323;
  const data = {
    run: {
      id: 42,
      repository: {
        full_name: "Chronote-gg/Chronote",
        id: 849540249,
        owner: { id: 251985640 },
      },
      head_repository: { id: 849540249 },
      head_sha: identity.sourceSha,
      head_branch: "master",
      path: ".github/workflows/verify-production-bootstrap.yml",
      event: "workflow_dispatch",
      run_attempt: 1,
      status: "in_progress",
      conclusion: null,
      created_at: "2026-10-20T10:00:00Z",
      actor: { id: 2165323 },
      triggering_actor: { id: 2165323 },
    },
    environment,
    branch: nativeBranchPolicies(),
    custom: { total_count: 0, custom_deployment_protection_rules: [] },
    reviews: [
      {
        state: "approved",
        user: { id: 2165323, type: "User" },
        environments: [{ id: environment.id, name: "production" }],
      },
    ],
  };
  const get = async (path) => {
    if (path.endsWith("/approvals")) return data.reviews;
    if (path.includes("deployment-branch-policies")) return data.branch;
    if (path.endsWith("deployment_protection_rules")) return data.custom;
    return path.includes("/environments/") ? data.environment : data.run;
  };
  return { data, get };
}
test("real verification identity reuses native production approval checks without a Terraform invocation", async () => {
  const f = fixture();
  expect((await verifyAuthority(f.get, identity, 77)).review.user.id).toBe(
    2165323,
  );
});
test.each([
  "source",
  "attempt",
  "repo",
  "owner",
  "workflow",
  "branch",
  "unapproved",
  "bypass",
  "self-review",
  "environment",
  "branch-policy",
  "custom",
])("native verification refuses %s", async (fault) => {
  const f = fixture(),
    d = f.data;
  const edits = {
    source: () => {
      d.run.head_sha = "b".repeat(40);
    },
    attempt: () => {
      d.run.run_attempt = 2;
    },
    repo: () => {
      d.run.head_repository.id = 1;
    },
    owner: () => {
      d.run.repository.owner.id = 1;
    },
    workflow: () => {
      d.run.path = ".github/workflows/terraform-apply.yml";
    },
    branch: () => {
      d.run.head_branch = "other";
    },
    unapproved: () => {
      d.reviews = [];
    },
    bypass: () => {
      d.environment.can_admins_bypass = true;
    },
    "self-review": () => {
      d.environment.protection_rules[0].prevent_self_review = true;
    },
    environment: () => {
      d.environment.id = 1;
    },
    "branch-policy": () => {
      d.branch.total_count = 2;
    },
    custom: () => {
      d.custom.total_count = 1;
    },
  };
  edits[fault]();
  await expect(verifyAuthority(f.get, identity, 77)).rejects.toThrow();
});
test("actual workflow isolates the reviewed native approval, session and synthetic run", () => {
  const raw = readFileSync(
    ".github/workflows/verify-production-bootstrap.yml",
    "utf8",
  );
  const workflow = load(raw),
    job = workflow.jobs.verify;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(job.environment).toBe("production");
  expect(job["timeout-minutes"]).toBe(15);
  expect(job.if).toContain("github.run_attempt == 1");
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  const steps = job.steps;
  expect(
    steps.filter((step) =>
      step.run?.includes("verify-production-bootstrap.cjs"),
    ),
  ).toEqual([
    {
      name: "Verify approval, restricted session and encrypted synthetic storage",
      env: {
        BOOTSTRAP_VERIFICATION_STORAGE_JSON:
          "${{ secrets.BOOTSTRAP_VERIFICATION_STORAGE_JSON }}",
        GH_TOKEN: "${{ github.token }}",
      },
      run: "node scripts/deployment/verify-production-bootstrap.cjs run",
    },
  ]);
  expect(raw).not.toMatch(
    /upload-artifact|terraform (plan|apply|init)|DeleteObject|cleanup|AWS_SECRET_ACCESS_KEY|aws-actions\/|session_policy|vars\.|arn:aws:|meeting-notes-prod-private-evidence/,
  );
  expect(Object.keys(job.env)).toEqual([
    "VERIFICATION_SOURCE_SHA",
    "VERIFICATION_STORAGE_SHA256",
    "VERIFICATION_DEADLINE",
  ]);
});
