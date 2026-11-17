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

test("OIDC binds account provider, immutable repository, the two deploy environments, master and the deploy workflow", () => {
  const role = block("resource", "production_deploy");
  for (const key of [
    "aud",
    "sub",
    "repository_id",
    "repository_owner_id",
    "ref",
    "workflow",
  ]) {
    expect(role).toContain(`token.actions.githubusercontent.com:${key}`);
  }
  expect(role).toContain('"refs/heads/master"');
  expect(role).toContain('"Meeting Notes Bot Deploy"');
  expect(role).toMatch(
    /:sub"\s*=\s*\[for name in local\.production_deploy_environments : "repo:\$\{var\.github_owner\}\/\$\{var\.github_repository\}:environment:\$\{name\}"\]/,
  );
  expect(source).toMatch(
    /production_deploy_environments\s*=\s*\["production", "production-deploy"\]/,
  );
  expect(role).toContain(
    "data.aws_iam_openid_connect_provider.github_production_deploy[0].arn",
  );
  expect(role).not.toContain("StringLike");
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
    /ssm:StartSession|secretsmanager:GetSecretValue|ecs:RunTask/,
  );
  // StopTask exists only for an explicitly enabled retiring deploy.
  expect(source.match(/ecs:StopTask/g)).toHaveLength(1);
  expect(source).toMatch(
    /var\.ENABLE_DEPLOY_RETIRE \? \[\s*\{\s*Sid\s*=\s*"RetireOlderTasks",\s*Effect\s*=\s*"Allow",\s*Action\s*=\s*\["ecs:StopTask"\],/,
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
    /lifecycle\s*\{\s*prevent_destroy\s*=\s*true\r?\n/,
  );
  expect(readFileSync("_infra/api.tf", "utf8")).toMatch(
    /ignore_changes\s*=\s*\[default_action\]/,
  );
});

// The deploy role runs from an environment with no reviewer, so it keeps only
// what scripts/deployment/deploy.cjs and the deploy workflow call. The removed
// grants served the deleted lifecycle coordinator.
test("the deploy role carries no grant without a caller", () => {
  for (const removed of [
    "RuntimeAdmissionFence",
    "RuntimeManagedPolicyReadback",
    "RuntimePrincipalProbe",
    "ProducerInventoryInRegion",
    "ProducerTargetsInAccount",
    "ScheduledProducerTargetsInAccount",
    "ArtifactAuthorityChecks",
    "ProductionObservationAndPreflight",
  ])
    expect(source).not.toContain(`"${removed}"`);
  expect(source).not.toMatch(
    /iam:PutRolePolicy|iam:DeleteRolePolicy|ecs:ExecuteCommand|application-autoscaling:|"events:|scheduler:|dynamodb:Scan|dynamodb:PutItem|dynamodb:UpdateItem|dynamodb:ConditionCheckItem/,
  );
  const statement = (sid) =>
    source.match(
      new RegExp(`Sid\\s*=\\s*"${sid}"([\\s\\S]*?)\\n\\s*\\},`),
    )?.[1] ?? "";
  expect(
    [
      ...statement("DeploymentControlProtocol").matchAll(/"(dynamodb:[^"]+)"/g),
    ].map((match) => match[1]),
  ).toEqual(["dynamodb:Query"]);
  expect(
    [
      ...statement("ExistingTableKeysThroughDynamoDB").matchAll(
        /aws_dynamodb_table\.([a-z0-9_]+)\.name/g,
      ),
    ].map((match) => match[1]),
  ).toEqual(["deployment_control_table"]);
});

test("the environment protection note matches the README", () => {
  expect(
    readFileSync("_infra/README.md", "utf8").replace(/\s+/g, " "),
  ).toContain(
    "Terraform manages the environment but ignores those settings, so no plan changes them",
  );
});
