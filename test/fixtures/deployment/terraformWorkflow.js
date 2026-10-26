import process from "node:process";
import { Buffer } from "node:buffer";
import { expect, jest } from "@jest/globals";
const mockGuardState = { failure: "", reads: 0 };
jest.mock("../../../scripts/deployment/coordinator-aws.cjs", () => ({
  awsCli: async () => ({
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/guard/run",
  }),
}));
jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: class {
      async send() {
        mockGuardState.reads++;
        if (mockGuardState.failure) throw { name: mockGuardState.failure };
        return {};
      }
    },
  };
});
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrivateCommand } from "../../../scripts/deployment/terraform-process.cjs";
import { nativeGitHub } from "../../../scripts/deployment/terraform-native.cjs";
import { privateCaptureFixture } from "./privateCapture.js";
export const invocation = {
  repository: "Chronote-gg/Chronote",
  sourceSha: "a".repeat(40),
  workflowPath: ".github/workflows/terraform-plan.yml",
  runId: "10",
  runAttempt: 1,
  environment: "production",
  workspace: "default",
  scope: "full",
};
export function fixture() {
  mockGuardState.failure = "";
  mockGuardState.reads = 0;
  const directory = mkdtempSync(join(tmpdir(), "terraform-workflow-"));
  mkdirSync(join(directory, "_infra"));
  writeFileSync(join(directory, "_infra/.terraform.lock.hcl"), "reviewed-lock");
  const storage = privateCaptureFixture();
  storage.binding.retentionUntil = Math.floor(Date.now() / 1000) + 100000;
  const commands = [],
    controls = {
      exitCode: 2,
      environment: "production",
      planJson: undefined,
      fail: "",
      lostApply: false,
      applyTitle: "",
      planTitle: "Terraform Plan production/default/full",
      envChange: false,
      branchPolicyFault: false,
      branchPolicyDrift: "",
      producerAfter: false,
      producerSha: "a".repeat(40),
      plan: {
        resource_changes: [
          {
            address: "aws_kms_key.app_general",
            mode: "managed",
            change: { actions: ["no-op"] },
          },
          {
            address: "aws_dynamodb_table.deployment_control_table",
            mode: "managed",
            change: {
              actions: ["create"],
              after: { name: "app-DeploymentControlTable" },
            },
          },
        ],
      },
    };
  const script = join(directory, "fake-terraform.cjs");
  writeFileSync(
    script,
    `const fs=require('node:fs'); const a=process.argv.slice(2), op=a[1]; process.stderr.write('SECRET_STDERR'); if(op==='version') process.stdout.write(JSON.stringify({terraform_version:'1.14.0'})); else if(op==='show') process.stdout.write(a.includes('-json') ? process.env.PLAN_JSON : 'PRIVATE_REVIEW'); else process.stdout.write('SECRET_STDOUT'); if(op==='plan') {fs.writeFileSync('_infra/tfplan',Buffer.from([0,255,13,10]));fs.writeFileSync('_infra/discord_alert.zip',Buffer.from([80,75,255]));} process.exitCode=op===process.env.FAIL ? 1 : op==='plan' ? Number(process.env.PLAN_EXIT) : 0;`,
  );
  const command = async (file, args, options) => {
    commands.push({ file, args });
    const actual =
      file === "terraform"
        ? process.execPath
        : file === "python3"
          ? "python"
          : file;
    const actualArgs = file === "terraform" ? [script, ...args] : args;
    const record = await runPrivateCommand(actual, actualArgs, {
      ...options,
      env: {
        ...options.env,
        PLAN_EXIT: String(controls.exitCode),
        FAIL: controls.fail,
        PLAN_JSON: JSON.stringify(controls.planJson ?? controls.plan),
      },
    });
    if (file === "terraform" && args[1] === "apply" && controls.lostApply)
      return { ...record, exitCode: null, outcome: "unknown" };
    return record;
  };
  const get = nativeGitHub("fake-token", async (url, options) => {
    expect(options.headers.Authorization).toBe("Bearer fake-token");
    let value;
    if (url.endsWith("/approvals"))
      value = [
        {
          state: "approved",
          comment: "reviewed",
          environments: [{ id: 7, name: controls.environment }],
          user: { id: 2, type: "User" },
        },
      ];
    else if (url.endsWith("/deployment_protection_rules"))
      value = { total_count: 0, custom_deployment_protection_rules: [] };
    else if (url.includes("/deployment-branch-policies?")) {
      value = nativeBranchPolicies();
      if (controls.branchPolicyFault) delete value.branch_policies[0].type;
      if (
        (controls.branchPolicyDrift === "before-apply" &&
          commands.filter((c) => c.args[1] === "validate").length >= 2) ||
        (controls.branchPolicyDrift === "after-apply" &&
          commands.some((c) => c.args[1] === "apply"))
      )
        value.branch_policies[0].id = 12;
    } else if (url.includes("/environments/"))
      value = nativeEnvironment(
        controls.environment,
        controls.envChange &&
          commands.filter((c) => c.args[1] === "validate").length >= 2
          ? "2026-10-21T12:00:00Z"
          : "2026-10-19T10:00:00Z",
      );
    else {
      const plan = url.endsWith("/10");
      value = nativeRun(controls, commands, plan);
    }
    return {
      ok: true,
      headers: { get: () => null },
      body: [Buffer.from(JSON.stringify(value))],
    };
  });
  const env = {
    DEPLOYMENT_ENVIRONMENT: "production",
    DEPLOYMENT_ACCOUNT_ID: "123456789012",
    DEPLOYMENT_CONTROL_TABLE: "app-DeploymentControlTable",
    DEPLOYMENT_GUARD_ROLE_ARN: "arn:aws:iam::123456789012:role/guard",
    AWS_REGION: "us-east-1",
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TERRAFORM_TFVARS_JSON: JSON.stringify({
      GITHUB_TOKEN: "fake",
      DISCORD_CLIENT_ID: "123",
      AWS_TOKEN_KEY: "fake",
    }),
    GITHUB_VARS_JSON: "{}",
  };
  function options(current = invocation) {
    if (current.workflowPath.endsWith("terraform-plan.yml"))
      controls.planTitle = `Terraform Plan ${current.environment}/${current.workspace}/${current.scope}`;
    const privateDirectory = join(directory, "private-" + current.runId);
    mkdirSync(privateDirectory);
    return {
      invocation: { ...current },
      directory,
      privateDirectory,
      env,
      binding: storage.binding,
      client: storage.client,
      get,
      command,
      signal: new AbortController().signal,
    };
  }
  return {
    directory,
    storage,
    commands,
    controls,
    options,
    guard: mockGuardState,
  };
}

function nativeRun(controls, commands, plan) {
  return {
    display_title: plan ? controls.planTitle : controls.applyTitle,
    id: plan ? 10 : 20,
    repository: { full_name: invocation.repository },
    head_repository: { full_name: invocation.repository },
    head_sha: plan ? controls.producerSha : invocation.sourceSha,
    head_branch: "master",
    path: plan
      ? invocation.workflowPath
      : ".github/workflows/terraform-apply.yml",
    event: "workflow_dispatch",
    run_attempt: 1,
    status: plan && commands.length ? "completed" : "in_progress",
    conclusion: plan && commands.length ? "success" : null,
    created_at: plan ? "2026-10-20T09:00:00Z" : "2026-10-20T10:00:00Z",
    updated_at: controls.producerAfter
      ? "2026-10-20T11:00:00Z"
      : "2026-10-20T09:10:00Z",
    actor: { id: 1 },
    triggering_actor: { id: 1 },
  };
}

export function nativeEnvironment(
  name = "production",
  updatedAt = "2026-10-19T10:00:00Z",
) {
  return {
    id: 7,
    name,
    updated_at: updatedAt,
    can_admins_bypass: false,
    protection_rules: [
      {
        id: 9,
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { id: 2, type: "User" } }],
      },
      ...(name === "production" ? [{ id: 10, type: "branch_policy" }] : []),
    ],
    deployment_branch_policy:
      name === "production"
        ? { protected_branches: false, custom_branch_policies: true }
        : null,
  };
}

export function nativeBranchPolicies() {
  return {
    total_count: 1,
    branch_policies: [{ id: 11, name: "master", type: "branch" }],
  };
}
