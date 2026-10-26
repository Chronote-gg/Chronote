/** @jest-environment node */
import { Buffer } from "node:buffer";
import { executeTerraformDispatch } from "../fixtures/deployment/terraformDispatchVm.js";
import process from "node:process";
import { test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { runTitle } from "../../scripts/deployment/terraform-native.cjs";
import { spawnSync } from "node:child_process";
import { parseDispatch } from "../../scripts/deployment/terraform-dispatch.cjs";
const sha = "a".repeat(40);
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "Chronote-gg/Chronote",
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_WORKFLOW_REF:
    "Chronote-gg/Chronote/.github/workflows/terraform-plan.yml@refs/heads/master",
  GITHUB_REF: "refs/heads/master",
  GITHUB_RUN_ID: "10",
  GITHUB_RUN_ATTEMPT: "1",
};
const event = {
  repository: { full_name: env.GITHUB_REPOSITORY },
  inputs: {
    github_environment: "production",
    terraform_workspace: "default",
    plan_scope: "full",
  },
};
test("dispatch derives exact trusted source and validates immutable input values", () => {
  expect(parseDispatch(env, event).invocation.sourceSha).toBe(sha);
  for (const patch of [
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_WORKFLOW_REF: "other" },
  ])
    expect(() => parseDispatch({ ...env, ...patch }, event)).toThrow();
  expect(() =>
    parseDispatch(env, {
      ...event,
      inputs: { ...event.inputs, github_environment: "PRIVATE_SENTINEL" },
    }),
  ).toThrow();
});
test("outer executable never prints malformed private configuration or exception paths", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/deployment/terraform-dispatch.cjs"],
    {
      encoding: "utf8",
      env: {
        ...env,
        GITHUB_EVENT_PATH: "SECRET_SENTINEL",
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe('{"status":"refused"}');
  expect(result.stderr).toBe("");
});

test.each(["plan", "apply"])(
  "%s workflow routes all Terraform through the private boundary and pins checkout",
  (mode) => {
    const workflow = parse(
      readFileSync(`.github/workflows/terraform-${mode}.yml`, "utf8"),
    );
    expect(Object.keys(workflow.jobs)).toEqual([mode]);
    const steps = workflow.jobs[mode].steps;
    expect(
      steps.find((step) => step.uses?.startsWith("actions/checkout")).with.ref,
    ).toBe("${{ github.sha }}");
    expect(
      steps.some((step) =>
        /upload-artifact|download-artifact/.test(step.uses ?? ""),
      ),
    ).toBe(false);
    const commands = steps.filter((step) => step.run).map((step) => step.run);
    expect(commands).toEqual([
      ...(mode === "plan"
        ? ["bash scripts/ci-install-dependencies.sh"]
        : [
            "bash scripts/ci-install-dependencies.sh\nyarn build\n",
            "node scripts/deployment/production-writer-guard.cjs --inspect",
          ]),
      "set +x\nnode scripts/deployment/terraform-dispatch.cjs\n",
    ]);
    const inputs =
      mode === "plan"
        ? event.inputs
        : {
            ...event.inputs,
            plan_run_id: "10",
            artifact_name: "terraform-plan-production-default-10",
            plan_sha256: "b".repeat(64),
            bundle_sha256: "c".repeat(64),
            confirmation: "apply",
          };
    const invocation = {
      repository: env.GITHUB_REPOSITORY,
      sourceSha: sha,
      workflowPath: `.github/workflows/terraform-${mode}.yml`,
      runId: "20",
      runAttempt: 1,
      environment: "production",
      workspace: "default",
      scope: "full",
    };
    const rendered = workflow["run-name"].replace(
      /\$\{\{ inputs\.([a-z_0-9]+) \}\}/g,
      (_, name) => inputs[name],
    );
    expect(rendered).toBe(
      runTitle(invocation, {
        producerRunId: "10",
        planSha256: "b".repeat(64),
        bundleSha256: "c".repeat(64),
      }),
    );
  },
);

async function executeDispatchBoundary(status, summaryFails = true) {
  let invocations = 0;
  const fakeProcess = {
    env: {
      ...env,
      GH_TOKEN: "fake-token",
      GITHUB_EVENT_PATH: "event",
      RUNNER_TEMP: "private",
      TERRAFORM_PRIVATE_STORAGE_JSON: "{}",
      GITHUB_STEP_SUMMARY: "summary",
    },
    umask: () => {},
    cwd: () => "checkout",
    once: () => {},
    removeListener: () => {},
    exitCode: undefined,
  };
  const modules = {
    "node:fs": {
      readFileSync: () => JSON.stringify(event),
      mkdirSync: () => {},
      appendFileSync: () => {
        if (summaryFails) throw new Error("SECRET_SUMMARY_ERROR");
      },
    },
    "node:child_process": { execFileSync: () => sha },
    "./terraform-native.cjs": { nativeGitHub: () => () => {} },
    "./terraform-workflow.cjs": {
      runTerraform: async () => {
        invocations++;
        if (status === "throw") throw new Error("SECRET_DELEGATED_ERROR");
        return { status };
      },
    },
  };
  const messages = await executeTerraformDispatch(modules, fakeProcess);
  return { messages, invocations, exitCode: fakeProcess.exitCode };
}

test.each(["unknown", "applied", "refused"])(
  "summary failure preserves the %s execution result without retry",
  async (status) => {
    const result = await executeDispatchBoundary(status);
    expect(result.messages).toEqual([JSON.stringify({ status })]);
    expect(result.invocations).toBe(1);
    expect(result.exitCode).toBe(1);
  },
);
test("unexpected delegated failure stays unknown without raw errors or retry", async () => {
  const result = await executeDispatchBoundary("throw", false);
  expect(result.messages).toEqual(['{"status":"unknown"}']);
  expect(result.invocations).toBe(1);
  expect(result.exitCode).toBe(1);
});

test("delivery scope is Sandbox-only and retains every upstream scope", () => {
  for (const scope of [
    "full",
    "purchase-permission",
    "deployment-prerequisites",
    "meeting-update-delivery",
  ])
    for (const environment of scope === "meeting-update-delivery"
      ? ["sandbox"]
      : ["production", "sandbox"])
      expect(
        parseDispatch(env, {
          ...event,
          inputs: {
            github_environment: environment,
            terraform_workspace:
              environment === "production" ? "default" : "sandbox",
            plan_scope: scope,
          },
        }).invocation.scope,
      ).toBe(scope);
  expect(() =>
    parseDispatch(env, {
      ...event,
      inputs: { ...event.inputs, plan_scope: "meeting-update-delivery" },
    }),
  ).toThrow();
});

test.each(["plan", "apply"])(
  "%s Sandbox uses OIDC with a bounded session and no static fallback",
  (mode) => {
    const workflow = parse(
      readFileSync(`.github/workflows/terraform-${mode}.yml`, "utf8"),
    );
    expect(workflow.permissions["id-token"]).toBe("write");
    expect(workflow.on.workflow_dispatch.inputs.plan_scope.options).toContain(
      "meeting-update-delivery",
    );
    expect(workflow.on.workflow_dispatch.inputs.plan_scope.options).toContain(
      "deployment-prerequisites",
    );
    const steps = workflow.jobs[mode].steps;
    const staticStep = steps.find((s) => s.with?.["aws-access-key-id"]);
    if (mode === "plan")
      expect(staticStep.if).toBe(
        "${{ inputs.github_environment == 'production' }}",
      );
    else {
      expect(staticStep).toBeUndefined();
      const production = steps.find(
        (s) =>
          s.with?.["role-to-assume"] ===
          "${{ vars.PRODUCTION_APPLY_ROLE_ARN }}",
      );
      expect(production.if).toBe("inputs.github_environment == 'production'");
    }
    const oidc = steps.find(
      (s) =>
        s.with?.["role-to-assume"] === "${{ vars.TERRAFORM_AWS_ROLE_ARN }}",
    );
    expect(oidc.if).toBe("${{ inputs.github_environment == 'sandbox' }}");
    expect(oidc.with["role-to-assume"]).toBe(
      "${{ vars.TERRAFORM_AWS_ROLE_ARN }}",
    );
    expect(oidc.with["allowed-account-ids"]).toBe("${{ vars.AWS_ACCOUNT_ID }}");
    expect(oidc.with["role-session-name"]).toContain("github.run_id");
    expect(oidc.with["role-duration-seconds"]).toBe(3600);
    if (mode === "plan") {
      const policy = JSON.parse(oidc.with["inline-session-policy"]);
      expect(
        policy.Statement.flatMap((statement) => statement.Action).join(" "),
      ).not.toMatch(
        /cloudfront:|acm:|route53:|s3:GetReplicationConfiguration|s3:GetAccelerateConfiguration/,
      );
      expect(
        policy.Statement.find((s) => s.Action.includes("s3:GetObject"))
          .Resource,
      ).toBe(
        "arn:aws:s3:::*/meeting-notes-terraform/sandbox/meeting-notes-terraform/state",
      );
      expect(
        Buffer.byteLength(oidc.with["inline-session-policy"]),
      ).toBeLessThanOrEqual(2048);
      expect(
        policy.Statement.some(
          (s) =>
            s.Action.includes("s3:PutObject") &&
            s.Resource === "arn:aws:s3:::*/terraform/sandbox/*",
        ),
      ).toBe(true);
      for (const s of policy.Statement) {
        expect(s.Effect).toBe("Allow");
        expect(s.Action).not.toContain("*");
        expect(s.Action.join(" ")).not.toMatch(
          /UpdateTable|CreatePolicyVersion|DeletePolicy|PassRole/,
        );
        if (s.Action.includes("s3:PutObject"))
          expect(s.Resource).toBe("arn:aws:s3:::*/terraform/sandbox/*");
      }
    }
  },
);
