/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { runtimePlan } from "../fixtures/deployment/runtimePlan.js";

const guard = "scripts/deployment/validate-runtime-plan.cjs";
type Plan = ReturnType<typeof runtimePlan>;
type Change = Plan["resource_changes"][number];

function validate(input: unknown) {
  return spawnSync(process.execPath, [guard], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}
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
const targetGroup = "aws_lb_target_group.api_tg[0]";

test("accepts the runtime creates, policy update, index addition and drain delay", () => {
  const result = validate(runtimePlan());
  expect(result.status).toBe(0);
  const accepted = JSON.parse(result.stdout);
  expect(accepted.result).toBe("accepted");
  expect(accepted.changes).toHaveLength(11);
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
  [targetGroup, ["create", "delete"]],
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
      after.deregistration_delay = "60";
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
])("rejects a target group update with %s", (_name, mutate) =>
  rejected((plan) => {
    mutate(find(plan, targetGroup).change.after as never);
  }),
);

test("refuses invalid JSON with a sanitized error", () => {
  const result = spawnSync(process.execPath, [guard], {
    input: "SECRET-PLAN-VALUE",
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("SECRET-PLAN-VALUE");
});
