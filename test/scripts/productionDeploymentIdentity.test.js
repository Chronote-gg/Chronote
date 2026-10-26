/** @jest-environment node */
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@jest/globals";

const path = "_infra/production-deployment.tf";
const source = existsSync(path) ? readFileSync(path, "utf8") : "";
const block = (type, name) =>
  source.match(
    new RegExp(`${type} "[^"]+" "${name}" \\{([\\s\\S]*?)\\n\\}`, "m"),
  )?.[1] ?? "";

test("production deployment infrastructure exists independently of Sandbox", () => {
  expect(source).not.toBe("");
  expect(block("resource", "production_deploy")).toContain(
    'var.environment == "prod"',
  );
  expect(source).not.toContain("refs/heads/codex/");
  expect(source).not.toContain("environment:sandbox");
});

test("OIDC binds account provider, immutable repository, production and master", () => {
  const role = block("resource", "production_deploy");
  for (const key of [
    "aud",
    "sub",
    "repository_id",
    "repository_owner_id",
    "ref",
  ]) {
    expect(role).toContain(`token.actions.githubusercontent.com:${key}`);
  }
  expect(role).toContain('"refs/heads/master"');
  expect(role).toContain(":environment:production");
  expect(role).toContain(
    "data.aws_iam_openid_connect_provider.github_production_deploy[0].arn",
  );
  expect(role).not.toContain("StringLike");
});

test("fence writes are role scoped with no invented policy-name condition", () => {
  expect(source).toMatch(
    /Sid\s*=\s*"RuntimeAdmissionFence"[\s\S]*?Resource\s*=\s*aws_iam_role.ecs_task_app_role.arn/,
  );
  expect(source).toContain('"iam:PutRolePolicy"');
  expect(source).toContain('"iam:DeleteRolePolicy"');
  expect(source).not.toMatch(
    /iam:(PolicyName|PolicyDocument|CreateRole|AttachRolePolicy|UpdateAssumeRolePolicy)/,
  );
});

test("observation covers exactly the eight existing maintenance table slots", () => {
  const observation =
    source.match(
      /Sid\s*=\s*"ProductionObservationAndPreflight"([\s\S]*?)\n\s*\},/,
    )?.[1] ?? "";
  const tables = [
    ...observation.matchAll(/aws_dynamodb_table\.([a-z0-9_]+)\.arn/g),
  ].map((match) => match[1]);
  expect(tables.sort()).toEqual(
    [
      "active_meeting_table",
      "meeting_history_table",
      "meeting_control_command_table",
      "personal_media_upload_job_table",
      "personal_recording_segment_table",
      "guild_subscription_table",
      "stripe_webhook_event_table",
      "payment_transaction_table",
    ].sort(),
  );
  expect(source).not.toContain('resource "aws_dynamodb_table"');
});

test("runtime Exec grants exactly four channel actions and no session authority", () => {
  const runtime = block("resource", "production_exec_channels");
  expect(
    [...runtime.matchAll(/"(ssmmessages:[^"]+)"/g)]
      .map((match) => match[1])
      .sort(),
  ).toEqual(
    [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ].sort(),
  );
  expect(runtime).toContain('var.environment == "prod"');
  expect(runtime).toMatch(/role\s*=\s*aws_iam_role.ecs_task_app_role.id/);
  expect(runtime).toMatch(/Resource\s*=\s*"\*"/);
  expect(source).not.toMatch(
    /ssm:StartSession|secretsmanager:GetSecretValue|ecs:StopTask|ecs:RunTask/,
  );
});

test("production wiring reuses routing and publishes its explicit role variable", () => {
  expect(source).toContain('"PRODUCTION_BACKEND_DEPLOY_ROLE_ARN"');
  expect(source).toContain('output "production_backend_deploy_role_arn"');
  expect(source).toContain("aws_iam_policy.deployment_routing[0].arn");
  const main = readFileSync("_infra/main.tf", "utf8");
  expect(main).toMatch(
    /ignore_changes\s*=\s*\[task_definition, load_balancer\]/,
  );
  const environment =
    main.match(
      /resource "github_repository_environment" "repo_env" \{([\s\S]*?)\n\}/,
    )?.[1] ?? "";
  expect(environment).toMatch(
    /lifecycle\s*\{\s*prevent_destroy\s*=\s*true\s*\}/,
  );
  expect(readFileSync("_infra/api.tf", "utf8")).toMatch(
    /ignore_changes\s*=\s*\[default_action\]/,
  );
});

test("policy readback covers every existing managed runtime attachment", () => {
  const readback =
    source.match(
      /Sid\s*=\s*"RuntimeManagedPolicyReadback"([\s\S]*?)\n\s*\},/,
    )?.[1] ?? "";
  expect(
    [...readback.matchAll(/aws_iam_policy\.([a-z0-9_]+)\.arn/g)]
      .map((match) => match[1])
      .sort(),
  ).toEqual(
    [
      "dynamodb_access_policy",
      "kms_app_policy",
      "transcripts_s3_policy",
      "appconfig_access_policy",
      "bedrock_data_automation_policy",
      "bedrock_s3_policy",
    ].sort(),
  );
});

test("producer authority is discovery only and preserves the production approval prerequisite", () => {
  const actions = [
    ...source.matchAll(
      /"((?:application-autoscaling|events|scheduler):[^"]+)"/g,
    ),
  ].map((match) => match[1]);
  expect(actions).toHaveLength(9);
  expect(actions.every((action) => /:(Describe|List|Get)/.test(action))).toBe(
    true,
  );
  expect(readFileSync("_infra/README.md", "utf8")).toContain(
    "must fail closed when required environment protection is absent",
  );
});
