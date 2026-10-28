/** @jest-environment node */
import { expect, test } from "@jest/globals";
import {
  githubTrust,
  runtimeAccountId,
  runtimePlan,
} from "../fixtures/deployment/runtimePlan.js";
import {
  runPlanGuard,
  runtimeGuard,
} from "../fixtures/deployment/planGuard.js";

type Plan = ReturnType<typeof runtimePlan>;
type Change = Plan["resource_changes"][number];

const validate = (input: unknown, account = runtimeAccountId) =>
  runPlanGuard(runtimeGuard, JSON.stringify(input), [account]);
function find(plan: Plan, address: string): Change {
  const resource = plan.resource_changes.find((r) => r.address === address);
  if (!resource) throw new Error(`missing ${address}`);
  return resource;
}
function rejected(mutate: (plan: Plan) => void) {
  const plan = runtimePlan();
  mutate(plan);
  const result = validate(plan);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("runtime plan rejected");
}
const table = "aws_dynamodb_table.guild_subscription_table";
const targetGroups = [
  "aws_lb_target_group.api_tg[0]",
  "aws_lb_target_group.api_spare_tg[0]",
];

test("accepts the runtime creates, policy update, index addition and drain delay", () => {
  const result = validate(runtimePlan());
  expect(result.status).toBe(0);
  const accepted = JSON.parse(result.stdout);
  expect(accepted.result).toBe("accepted");
  expect(accepted.changes).toHaveLength(12);
});

test("accepts targets that already match as no-ops", () => {
  const plan = runtimePlan();
  for (const resource of plan.resource_changes)
    if (resource.mode === "managed")
      resource.change = { actions: ["no-op"] } as Change["change"];
  expect(validate(plan).status).toBe(0);
});

test.each([
  "aws_ecs_service.app_service",
  "aws_ecs_task_definition.app_task",
  "aws_kms_key_policy.app_general",
  "aws_lb_listener.api_https[0]",
  "aws_lb_target_group.api_spare_tg[0]",
  "aws_cloudfront_distribution.frontend",
  "aws_dynamodb_table.meeting_history_table",
  'aws_iam_role.production_introduction["introduction"]',
  "github_actions_environment_variable.production_deploy_role[0]",
])("rejects a change to %s outside the scope", (address) =>
  rejected((plan) => {
    plan.resource_changes = plan.resource_changes.filter(
      (r) => r.address !== address,
    );
    plan.resource_changes.push({
      address,
      mode: "managed",
      change: { actions: ["update"] },
    } as Change);
  }),
);

test.each(["aws_kms_key.app_general", "aws_lb_listener.api_https[0]"])(
  "requires %s as an unchanged dependency",
  (address) =>
    rejected((plan) => {
      plan.resource_changes = plan.resource_changes.filter(
        (r) => r.address !== address,
      );
    }),
);

test.each([
  ["aws_iam_role.production_deploy[0]", ["delete", "create"]],
  ["aws_iam_role.production_deploy[0]", ["delete"]],
  ["aws_iam_policy.dynamodb_access_policy", ["create"]],
  [table, ["create"]],
  [table, ["delete", "create"]],
  [targetGroups[0], ["create", "delete"]],
  [targetGroups[1], ["delete", "create"]],
  ["aws_iam_role_policy_attachment.site_publishing[0]", ["update"]],
])("rejects %s with actions %j", (address, actions) =>
  rejected((plan) => {
    find(plan, address as string).change.actions = actions as string[];
  }),
);

test.each([
  [
    "import",
    (r: Change) => Object.assign(r.change, { importing: { id: "x" } }),
  ],
  ["move", (r: Change) => Object.assign(r, { previous_address: "x" })],
])("rejects a target %s", (_name, mutate) =>
  rejected((plan) => {
    mutate(find(plan, "aws_iam_role.production_deploy[0]"));
  }),
);

test.each([
  [
    "a second new index",
    (after: Record<string, unknown[]>) =>
      after.global_secondary_index.push({
        name: "Other",
        hash_key: "guildId",
        projection_type: "ALL",
      }),
  ],
  [
    "a different index key",
    (after: Record<string, Record<string, string>[]>) => {
      after.global_secondary_index[0].range_key = "guildId";
    },
  ],
  [
    "an extra attribute",
    (after: Record<string, unknown[]>) =>
      after.attribute.push({ name: "other", type: "S" }),
  ],
  [
    "a missing index attribute",
    (after: Record<string, unknown[]>) => after.attribute.pop(),
  ],
  [
    "another table setting",
    (after: Record<string, unknown>) => {
      after.point_in_time_recovery = [{ enabled: false }];
    },
  ],
  [
    "a changed name",
    (after: Record<string, unknown>) => {
      after.name = "other";
    },
  ],
])("rejects a subscription table update with %s", (_name, mutate) =>
  rejected((plan) => {
    mutate(find(plan, table).change.after as never);
  }),
);

test("rejects the index when it already exists before the update", () =>
  rejected((plan) => {
    const change = find(plan, table).change as {
      before: { global_secondary_index: unknown[] };
      after: { global_secondary_index: unknown[] };
    };
    change.before.global_secondary_index = [
      ...change.after.global_secondary_index,
    ];
  }));

test("rejects an unknown table setting", () =>
  rejected((plan) => {
    Object.assign(find(plan, table).change, {
      after_unknown: { stream_arn: true },
    });
  }));

test.each([
  [
    "another delay",
    (after: Record<string, unknown>) => {
      after.deregistration_delay = "30";
    },
  ],
  [
    "another attribute",
    (after: Record<string, unknown>) => {
      after.health_check = [{ path: "/" }];
    },
  ],
  [
    "a renamed group",
    (after: Record<string, unknown>) => {
      after.name = "other";
    },
  ],
])("rejects a target group update with %s", (_name, mutate) => {
  for (const address of targetGroups)
    rejected((plan) => {
      mutate(find(plan, address).change.after as never);
    });
});

test("rejects a known stream output change on the subscription table", () =>
  rejected((plan) => {
    const change = find(plan, table).change as {
      after: Record<string, unknown>;
      after_unknown: Record<string, unknown>;
    };
    delete change.after_unknown.stream_arn;
    change.after.stream_arn = "other";
  }));

test("refuses a missing or foreign account binding", () => {
  expect(validate(runtimePlan(), "").status).toBe(1);
  expect(validate(runtimePlan(), "999999999999").status).toBe(1);
});

const roles = [
  "aws_iam_role.production_deploy[0]",
  'aws_iam_role.production_introduction["prompt-guard"]',
];
type Trust = {
  Statement: {
    Principal: Record<string, string>;
    Condition: { StringEquals: Record<string, string> };
  }[];
};
test.each([
  [
    "a foreign provider",
    (t: Trust) => {
      t.Statement[0].Principal.Federated =
        "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com";
    },
  ],
  [
    "an extra principal",
    (t: Trust) => {
      t.Statement[0].Principal.AWS = "*";
    },
  ],
  [
    "a foreign subject",
    (t: Trust) => {
      t.Statement[0].Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
      ] = "repo:Chronote-gg/Chronote:environment:sandbox";
    },
  ],
  [
    "a second statement",
    (t: Trust) => {
      t.Statement.push({
        Principal: { AWS: "*" },
        Condition: { StringEquals: {} },
      });
    },
  ],
])("rejects role trust with %s", (_name, mutate) => {
  for (const address of roles)
    rejected((plan) => {
      const value = JSON.parse(githubTrust()) as Trust;
      mutate(value);
      Object.assign(find(plan, address).change, {
        after: { assume_role_policy: JSON.stringify(value) },
      });
    });
});

const policies = [
  "aws_iam_role_policy.production_deploy[0]",
  "aws_iam_policy.site_publishing[0]",
  "aws_iam_role_policy.production_exec_channels[0]",
  "aws_iam_policy.dynamodb_access_policy",
  "aws_iam_role_policy.production_prompt_guard[0]",
];
const allow = (Action: unknown, Resource: unknown = "arn:aws:s3:::bucket") => ({
  Effect: "Allow",
  Action,
  Resource,
});
test.each([
  ["any action", allow("*")],
  ["all IAM actions", allow(["s3:GetObject", "iam:*"])],
  ["all STS actions", allow("sts:*")],
  ["NotAction", { Effect: "Allow", NotAction: "s3:GetObject", Resource: "*" }],
  [
    "NotResource",
    { Effect: "Allow", Action: "s3:GetObject", NotResource: "x" },
  ],
  ["a write on every resource", allow(["ecs:ListTasks", "iam:PassRole"], "*")],
  [
    "a secret read on every resource",
    allow("secretsmanager:GetSecretValue", ["*"]),
  ],
])("rejects a policy granting %s", (_name, statement) => {
  for (const address of policies)
    rejected((plan) => {
      Object.assign(find(plan, address).change, {
        after: {
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [statement],
          }),
        },
      });
    });
});

test.each([null, "", "{}", '{"Statement":[]}'])(
  "rejects an unknown or empty policy document %j",
  (policy) => {
    for (const address of policies)
      rejected((plan) => {
        Object.assign(find(plan, address).change, { after: { policy } });
      });
  },
);
