"use strict";
const { z } = require("zod");
const { canonicalHash } = require("./production-manifest.cjs");
const { isDeepStrictEqual: same } = require("node:util");
const id = z.string().min(1).max(1024),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const policy = z
  .object({ arn: id, versionId: id, documentHash: hash })
  .strict();
const purposes = [
  "introduction",
  "collector",
  "task",
  "execution",
  "deploy",
  "apply",
  "promptGuard",
];
const role = z
  .object({
    purpose: z.enum(purposes),
    arn: id,
    roleId: id,
    trustHash: hash,
    inline: z
      .array(z.object({ name: id, documentHash: hash }).strict())
      .max(100),
    attached: z.array(policy).max(100),
    boundary: policy.nullable(),
  })
  .strict();
const workflow = z
  .object({
    kind: z.literal("workflow"),
    id,
    evidenceHash: hash,
    workflowId: z.number().int().positive(),
    path: id,
    state: z.enum(["active", "disabled_manually", "disabled_inactivity"]),
    environmentId: id,
  })
  .strict();
const variables = [
  "PRODUCTION_BACKEND_DEPLOY_ROLE_ARN",
  "PRODUCTION_APPLY_ROLE_ARN",
  "PRODUCTION_PROMPT_GUARD_ROLE_ARN",
  "AWS_ACCOUNT_ID",
  "AWS_REGION",
  "DEPLOYMENT_CONTROL_TABLE",
  "ECS_CLUSTER",
  "ECS_SERVICE",
  "ECS_TASK_FAMILY",
  "SECRETS_PREFIX",
  "LANGFUSE_BASE_URL",
  "DEPLOYMENT_LISTENER_ARN",
  "DEPLOYMENT_TARGET_GROUP_A",
  "DEPLOYMENT_TARGET_GROUP_B",
];
const repositoryVariables = [
  "AWS_REGION",
  "AWS_ACCOUNT_ID",
  "PRODUCTION_INTRODUCTION_ROLE_ARN",
  "PRODUCTION_ACCEPTANCE_COLLECTOR_ROLE_ARN",
];
const launcherSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("zero-external-launcher-mutations"),
    scope: z
      .object({
        repositoryId: id,
        repositoryOwnerId: id,
        repository: z.literal("Chronote-gg/Chronote"),
        sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
        ref: z.literal("refs/heads/master"),
        accountId: id,
        region: id,
        clusterArn: id,
        serviceArn: id,
        table: id,
      })
      .strict(),
    routes: z.tuple([
      workflow,
      workflow,
      workflow,
      z
        .object({
          kind: z.literal("manual"),
          id,
          evidenceHash: hash,
          status: z.literal("retired"),
        })
        .strict(),
    ]),
    github: z
      .object({
        environmentHash: hash,
        branchPolicyHash: hash,
        classicProtectionHash: hash,
        effectiveRulesHash: hash,
        actionsPolicyHash: hash,
        repositoryVariables: z
          .object(
            Object.fromEntries(repositoryVariables.map((name) => [name, id])),
          )
          .strict(),
        variables: z
          .object(Object.fromEntries(variables.map((name) => [name, id])))
          .strict(),
      })
      .strict(),
    roles: z.array(role).length(purposes.length),
    oidcProviders: z
      .array(
        z
          .object({
            arn: id,
            url: z.literal("token.actions.githubusercontent.com"),
            clientIds: z.tuple([z.literal("sts.amazonaws.com")]),
            thumbprints: z.array(id).min(1).max(5),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();
function refuse() {
  throw Error("launcher_settings_prerequisite");
}
function assertEnvironmentVariables(m, s, v) {
  const values = {
    AWS_ACCOUNT_ID: s.accountId,
    AWS_REGION: s.region,
    DEPLOYMENT_CONTROL_TABLE: s.table,
    ECS_TASK_FAMILY: m.runtime.family,
    DEPLOYMENT_LISTENER_ARN: m.resources.listenerArn,
    DEPLOYMENT_TARGET_GROUP_A: m.resources.targetGroupA,
    DEPLOYMENT_TARGET_GROUP_B: m.resources.targetGroupB,
  };
  if (Object.entries(values).some(([key, value]) => v[key] !== value)) refuse();
  if (
    ![s.clusterArn, s.clusterArn.split("/").at(-1)].includes(v.ECS_CLUSTER) ||
    ![s.serviceArn, s.serviceArn.split("/").at(-1)].includes(v.ECS_SERVICE)
  )
    refuse();
}
function assertDeclarationRolesAndVariables(m, declaration) {
  const s = declaration.scope;
  const expectedRepositoryVariables = {
    AWS_REGION: m.identity.region,
    AWS_ACCOUNT_ID: m.identity.accountId,
    PRODUCTION_INTRODUCTION_ROLE_ARN: m.identity.roleArn,
    PRODUCTION_ACCEPTANCE_COLLECTOR_ROLE_ARN: m.acceptance.collectorRoleArn,
  };
  if (
    !same(declaration.github.repositoryVariables, expectedRepositoryVariables)
  )
    refuse();
  const v = declaration.github.variables;
  const roleArns = {
    introduction: m.identity.roleArn,
    collector: m.acceptance.collectorRoleArn,
    task: m.resources.taskRoleArn,
    execution: m.resources.executionRoleArn,
    deploy: v.PRODUCTION_BACKEND_DEPLOY_ROLE_ARN,
    apply: v.PRODUCTION_APPLY_ROLE_ARN,
    promptGuard: v.PRODUCTION_PROMPT_GUARD_ROLE_ARN,
  };
  for (const r of declaration.roles) {
    if (
      r.arn !== roleArns[r.purpose] ||
      !r.arn.startsWith(`arn:aws:iam::${s.accountId}:role/`)
    )
      refuse();
    for (const list of [
      r.inline.map((p) => p.name),
      r.attached.map((p) => p.arn),
    ])
      if (!same(list, [...new Set(list)].sort())) refuse();
  }
  assertEnvironmentVariables(m, s, v);
}
function assertDeclaration(binding, input) {
  const m = binding.manifest,
    declaration = launcherSettingsSchema.parse(input),
    s = declaration.scope;
  if (canonicalHash(declaration) !== m.prerequisites.launcherHolds) refuse();
  const expected = {
    repository: m.identity.repository,
    sourceCommit: m.identity.sourceCommit,
    ref: m.identity.ref,
    accountId: m.identity.accountId,
    region: m.identity.region,
    clusterArn: m.runtime.clusterArn,
    serviceArn: m.runtime.serviceArn,
    table: m.resources.tables.deploymentControl,
  };
  if (Object.entries(expected).some(([key, value]) => s[key] !== value))
    refuse();
  if (
    !same(
      declaration.routes.map(({ kind, id, evidenceHash }) => ({
        kind,
        id,
        evidenceHash,
      })),
      m.launcherRoutes,
    )
  )
    refuse();
  if (
    !same(declaration.roles.map((r) => r.purpose).sort(), [...purposes].sort())
  )
    refuse();
  assertDeclarationRolesAndVariables(m, declaration);
  const [deploy, apply, staged, manual] = declaration.routes;
  if (
    deploy.path !== ".github/workflows/deploy.yml" ||
    apply.path !== ".github/workflows/terraform-apply.yml" ||
    staged.path !== ".github/workflows/production-introduction.yml" ||
    staged.id !== staged.path ||
    manual.id !== "scripts/force-deployment.ps1" ||
    deploy.id !== deploy.path ||
    apply.id !== apply.path
  )
    refuse();
  return declaration;
}
module.exports = {
  launcherSettingsSchema,
  assertDeclaration,
  variables,
  repositoryVariables,
  refuse,
};
