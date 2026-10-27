import {
  preservationPolicy,
  policyName,
} from "../../scripts/deployment/production-paused-policy.cjs";
import { completeManifest } from "./productionCompleteManifest.js";
import { protectedEnvironment } from "./productionProviderFixtures.js";
import { bound } from "./productionManifest.js";
import { canonicalHash as hash } from "../../scripts/deployment/production-manifest.cjs";
export function launcherFixture(m = completeManifest()) {
  const account = m.identity.accountId;
  m.identity.repository = "Chronote-gg/Chronote";
  m.identity.ref = "refs/heads/master";
  m.identity.workflow =
    "Chronote-gg/Chronote/.github/workflows/introduce-production.yml@refs/heads/master";
  const roles = {
    introduction: m.identity.roleArn,
    collector: m.acceptance.collectorRoleArn,
    task: m.resources.taskRoleArn,
    execution: m.resources.executionRoleArn,
    deploy: `arn:aws:iam::${account}:role/ordinary-deploy`,
    apply: `arn:aws:iam::${account}:role/apply`,
    promptGuard: `arn:aws:iam::${account}:role/prompt-guard`,
  };
  const oidc = `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;
  const variables = {
    PRODUCTION_BACKEND_DEPLOY_ROLE_ARN: roles.deploy,
    PRODUCTION_APPLY_ROLE_ARN: roles.apply,
    PRODUCTION_PROMPT_GUARD_ROLE_ARN: roles.promptGuard,
    AWS_ACCOUNT_ID: account,
    AWS_REGION: m.identity.region,
    DEPLOYMENT_CONTROL_TABLE: m.resources.tables.deploymentControl,
    ECS_CLUSTER: m.runtime.clusterArn,
    ECS_SERVICE: m.runtime.serviceArn,
    ECS_TASK_FAMILY: m.runtime.family,
    SECRETS_PREFIX: "synthetic",
    LANGFUSE_BASE_URL: "https://langfuse.invalid",
    DEPLOYMENT_LISTENER_ARN: m.resources.listenerArn,
    DEPLOYMENT_TARGET_GROUP_A: m.resources.targetGroupA,
    DEPLOYMENT_TARGET_GROUP_B: m.resources.targetGroupB,
  };
  const repositoryVariables = {
    AWS_ACCOUNT_ID: account,
    AWS_REGION: m.identity.region,
    PRODUCTION_INTRODUCTION_ROLE_ARN: m.identity.roleArn,
    PRODUCTION_ACCEPTANCE_COLLECTOR_ROLE_ARN: m.acceptance.collectorRoleArn,
  };
  const environment = protectedEnvironment("production");
  const branches = [{ id: 1, name: "master", type: "branch" }],
    classic = {
      enforce_admins: { enabled: true },
      required_status_checks: { strict: true, contexts: ["CI"] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    },
    actions = {
      enabled: true,
      allowed_actions: "all",
      selected_actions_url: null,
    };
  const inlinePolicies = new Map();
  const documents = new Map(),
    roleRows = new Map();
  for (const [purpose, arn] of Object.entries(roles)) {
    const statement = [
      {
        Effect: "Allow",
        Action: "sts:AssumeRoleWithWebIdentity",
        Principal: { Federated: oidc },
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": `repo:${m.identity.repository}:${purpose === "collector" ? "ref:refs/heads/master" : "environment:production"}`,
          },
        },
      },
    ];
    if (["task", "execution"].includes(purpose))
      statement.splice(0, 1, {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Principal: { Service: "ecs-tasks.amazonaws.com" },
      });
    if (purpose === "collector") {
      statement[0].Condition.StringLike = {
        "sts:RoleSessionName": "introduction-read-*-1",
      };
      statement.push({
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": [roles.introduction, roles.collector],
          },
          StringLike: {
            "sts:RoleSessionName": [
              "introduction-content-*-1-0",
              "introduction-content-*-1-1",
            ],
          },
        },
      });
    }
    const trust = { Version: "2012-10-17", Statement: statement };
    roleRows.set(arn.split("/").at(-1), {
      Arn: arn,
      RoleId: `ROLE-${purpose}`,
      AssumeRolePolicyDocument: trust,
    });
    documents.set(arn, trust);
  }
  const paths = [
    ".github/workflows/deploy.yml",
    ".github/workflows/terraform-apply.yml",
    ".github/workflows/production-introduction.yml",
    "scripts/force-deployment.ps1",
  ];
  m.launcherRoutes = paths.map((id, i) => ({
    kind: i === 3 ? "manual" : "workflow",
    id,
    evidenceHash: String(i + 1).repeat(64),
  }));
  const declaration = {
    schemaVersion: 1,
    mode: "zero-external-launcher-mutations",
    scope: {
      repositoryId: "1",
      repositoryOwnerId: "2",
      repository: m.identity.repository,
      sourceCommit: m.identity.sourceCommit,
      ref: m.identity.ref,
      accountId: account,
      region: m.identity.region,
      clusterArn: m.runtime.clusterArn,
      serviceArn: m.runtime.serviceArn,
      table: m.resources.tables.deploymentControl,
    },
    routes: m.launcherRoutes.map((r, i) => ({
      ...r,
      ...(i === 3
        ? { status: "retired" }
        : {
            workflowId: i + 1,
            path: r.id,
            state: "active",
            environmentId: "1",
          }),
    })),
    github: {
      environmentHash: hash(environment),
      branchPolicyHash: hash(
        branches.map(({ name, type }) => ({ name, type })),
      ),
      classicProtectionHash: hash(classic),
      effectiveRulesHash: hash([]),
      actionsPolicyHash: hash({ actions, selected: null }),
      variables,
      repositoryVariables,
    },
    roles: Object.entries(roles).map(([purpose, arn]) => ({
      purpose,
      arn,
      roleId: `ROLE-${purpose}`,
      trustHash: hash(documents.get(arn)),
      inline: [],
      attached: [],
      boundary: null,
    })),
    oidcProviders: [
      {
        arn: oidc,
        url: "token.actions.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
        thumbprints: ["f".repeat(40)],
      },
    ],
  };
  m.prerequisites.launcherHolds = hash(declaration);
  const binding = bound(m);
  const state = {
    extraRun: false,
    missingVariable: false,
    roleIdChanged: false,
    attachmentChanged: false,
    classicDenied: false,
    branchChanged: false,
    partialJobs: false,
    policyVersionChanged: false,
  };
  function workflowRuns(endpoint) {
    if (endpoint.includes("/attempts/1/jobs"))
      return {
        total_count: state.partialJobs ? 2 : 1,
        items: [
          {
            id: 1,
            name: "Accept production introduction",
            head_sha: m.identity.sourceCommit,
            status: "in_progress",
            conclusion: null,
          },
        ],
      };
    if (endpoint.includes("/actions/runs?")) {
      const items = [
        {
          id: Number(m.identity.runId),
          run_attempt: 1,
          path: ".github/workflows/introduce-production.yml",
          status: "in_progress",
          head_sha: m.identity.sourceCommit,
          head_branch: "master",
        },
      ];
      if (state.extraRun)
        items.push({ id: 99, status: "waiting", head_sha: "old" });
      return { total_count: items.length, items };
    }
    throw Error("unexpected GitHub read");
  }
  function variablePage(endpoint) {
    if (endpoint.includes("/actions/variables?")) {
      const items = Object.entries(repositoryVariables).map(
        ([name, value]) => ({ name, value }),
      );
      if (state.missingRepositoryVariable) items.pop();
      if (state.repositoryVariableChanged) items[0].value = "wrong";
      return { total_count: items.length, items };
    }
    if (endpoint.includes("/variables?")) {
      const items = Object.entries(variables).map(([name, value]) => ({
        name,
        value,
      }));
      if (state.missingVariable) items.pop();
      return { total_count: items.length, items };
    }
  }
  const github = async (endpoint) => {
    if (endpoint.endsWith("/Chronote"))
      return { id: 1, ownerId: 2, full_name: m.identity.repository };
    if (endpoint.includes("/git/ref/"))
      return {
        ref: m.identity.ref,
        object: { type: "commit", sha: m.identity.sourceCommit },
      };
    if (endpoint.includes("/actions/workflows/")) {
      const r = declaration.routes.find((r) =>
        endpoint.endsWith(r.path?.split("/").at(-1)),
      );
      return { id: r.workflowId, path: r.path, state: r.state };
    }
    if (endpoint.endsWith("/environments/production")) return environment;
    if (endpoint.includes("/deployment-branch-policies"))
      return {
        total_count: 1,
        items: state.branchChanged
          ? [{ id: 1, name: "other", type: "branch" }]
          : branches,
      };
    if (endpoint.includes("/variables?")) return variablePage(endpoint);
    if (endpoint.includes("/branches/master/protection")) {
      if (state.classicDenied) throw Error("404");
      return classic;
    }
    if (endpoint.includes("/rules/branches")) return [];
    if (endpoint.endsWith("/actions/permissions")) return actions;
    return workflowRuns(endpoint);
  };
  const aws = async (service, operation, input) => {
    if (service !== "iam") throw Error("unexpected provider");
    if (operation === "get-role")
      return {
        Role: {
          ...roleRows.get(input.RoleName),
          ...(state.roleIdChanged ? { RoleId: "changed" } : {}),
        },
      };
    if (operation === "list-role-policies")
      return {
        PolicyNames: [...(inlinePolicies.get(input.RoleName)?.keys() ?? [])],
        IsTruncated: false,
      };
    if (operation === "get-role-policy")
      return {
        RoleName: input.RoleName,
        PolicyName: input.PolicyName,
        PolicyDocument: inlinePolicies
          .get(input.RoleName)
          ?.get(input.PolicyName),
      };
    if (operation === "list-attached-role-policies")
      return {
        AttachedPolicies: state.attachmentChanged
          ? [{ PolicyArn: "extra" }]
          : [],
        IsTruncated: false,
      };
    if (operation === "get-open-id-connect-provider")
      return {
        Url: "token.actions.githubusercontent.com",
        ClientIDList: ["sts.amazonaws.com"],
        ThumbprintList: ["f".repeat(40)],
      };
    throw Error("unexpected IAM read");
  };
  return { binding, declaration, state, roleRows, inlinePolicies, github, aws };
}

export function bindPreservationPolicies(launcher, scope) {
  for (const purpose of ["introduction", "collector"]) {
    const role = launcher.declaration.roles.find(
      (row) => row.purpose === purpose,
    );
    const document = preservationPolicy(scope, purpose);
    launcher.inlinePolicies.set(
      role.arn.split("/").at(-1),
      new Map([[policyName, document]]),
    );
    role.inline = [{ name: policyName, documentHash: hash(document) }];
  }
  launcher.binding.manifest.prerequisites.launcherHolds = hash(
    launcher.declaration,
  );
}
