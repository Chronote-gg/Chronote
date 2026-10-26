/** @jest-environment node */
import process from "node:process";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
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
      "bash scripts/ci-install-dependencies.sh",
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
  const realRequire = createRequire(
    join(process.cwd(), "scripts/deployment/terraform-dispatch.cjs"),
  );
  const messages = [];
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
  await runInNewContext(
    readFileSync("scripts/deployment/terraform-dispatch.cjs", "utf8") +
      "\nmain();",
    {
      require: (name) => modules[name] ?? realRequire(name),
      module: { exports: {} },
      process: fakeProcess,
      console: { log: (value) => messages.push(value) },
      AbortController,
      setTimeout,
      clearTimeout,
    },
  );
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
