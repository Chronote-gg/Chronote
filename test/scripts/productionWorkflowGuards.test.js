/** @jest-environment node */
import { readFileSync } from "node:fs";
import { test, expect } from "@jest/globals";
const read = (name) =>
  readFileSync(`.github/workflows/${name}.yml`, "utf8").replace(/\r\n/g, "\n");
test("backend and prompts check holds before their writes and share noncanceling production lock", () => {
  const deploy = read("deploy");
  expect(deploy.indexOf("production-writer-guard.cjs")).toBeLessThan(
    deploy.indexOf("docker push"),
  );
  const prompts = deploy.slice(deploy.indexOf("  promote-prompts:"));
  expect(prompts).toContain("environment: production");
  expect(prompts).toContain("PRODUCTION_PROMPT_GUARD_ROLE_ARN");
  expect(prompts).toContain("id-token: write");
  expect(prompts.indexOf("production-writer-guard.cjs")).toBeLessThan(
    prompts.indexOf("          yarn prompts:push\n"),
  );
  expect(deploy).toContain("steps.hold-guard.outcome == 'success'");
});
test("Apply retains private delivery and invokes the native guard at the saved-plan boundary", () => {
  const apply = read("terraform-apply");
  expect(apply).toContain("chronote-deploy-production");
  expect(apply).toContain("terraform-dispatch.cjs");
  expect(apply).not.toContain("upload-artifact");
  const native = readFileSync(
    "scripts/deployment/terraform-workflow.cjs",
    "utf8",
  );
  expect(native).toContain("await runGuard(options.env, false, prerequisite)");
  expect(
    native.indexOf("await runGuard(options.env, false, prerequisite)"),
  ).toBeLessThan(native.indexOf('await e.terraform(["apply"'));
  expect(read("terraform-plan")).toContain("deployment-prerequisites");
  expect(read("terraform-plan")).toContain("deployment-runtime");
  expect(read("terraform-plan")).toContain("site-delivery");
  expect(read("terraform-plan")).toContain("processing-retry");
});

test("same-run continuation has a credential-free separately protected gate and immutable session/package inputs", () => {
  const workflow = read("introduce-production");
  const gate = workflow.slice(
    workflow.indexOf("  approve-continuation:"),
    workflow.indexOf("  continue:"),
  );
  expect(gate).toContain("environment: production-continuation");
  expect(gate).toContain("permissions: {}");
  for (const capability of [
    "id-token",
    "configure-aws",
    "INTRODUCTION_OPS_READ_TOKEN",
    "actions/checkout",
  ])
    expect(gate).not.toContain(capability);
  const continuation = workflow.slice(workflow.indexOf("  continue:"));
  expect(continuation).toContain(
    "needs.approve-continuation.result == 'success'",
  );
  expect(
    workflow.match(
      /role-session-name: introduction-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/g,
    ),
  ).toHaveLength(3);
  expect(workflow).toContain("group: chronote-deploy-production");
  expect(workflow).toContain("cancel-in-progress: false");
});

test("connection sync uses the existing guard identity before secret read and publication", () => {
  const sync = read("deploy").split("  sync-openai-connection:")[1];
  expect(sync).toContain("PRODUCTION_PROMPT_GUARD_ROLE_ARN");
  expect(sync).toContain("id-token: write");
  expect(sync).toContain("unset-current-credentials: true");
  expect(sync).not.toMatch(/aws-access-key-id|aws-secret-access-key/);
  expect(sync.indexOf("production-writer-guard.cjs")).toBeLessThan(
    sync.indexOf("secretsmanager get-secret-value"),
  );
  expect(sync).toMatch(
    /production-writer-guard.cjs\s+yarn llm-connections:push --dir "\$connections_dir"\s/,
  );
});
