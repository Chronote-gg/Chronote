/** @jest-environment node */
import { expect, test } from "@jest/globals";
import {
  prerequisiteGuard,
  runPlanGuard,
  runtimeGuard,
  siteGuard,
} from "../fixtures/deployment/planGuard.js";

const targets = [
  "aws_dynamodb_table.deployment_control_table",
  "aws_lb_target_group.api_spare_tg[0]",
  "aws_iam_role_policy.deployment_control",
  "aws_iam_policy.deployment_routing[0]",
];
const kms = {
  address: "aws_kms_key.app_general",
  mode: "managed",
  change: { actions: ["no-op"] },
};
function change(address: string, actions = ["update"], mode = "managed") {
  return {
    address,
    mode,
    change: {
      actions,
      before: "SECRET-PLAN-VALUE",
      after: "SECRET-PLAN-VALUE",
    },
  };
}
const validate = (input: unknown) =>
  runPlanGuard(prerequisiteGuard, JSON.stringify(input));

test("accepts only the four prerequisite creates/updates, existing key no-op and dependent reads", () => {
  const result = validate({
    resource_changes: [
      kms,
      ...targets.map((address, i) =>
        change(address, [i % 2 ? "create" : "update"]),
      ),
      change("aws_vpc.app_vpc", ["no-op"]),
      change("data.aws_caller_identity.current", ["read"], "data"),
    ],
  });
  expect(result.status).toBe(0);
  for (const address of targets) expect(result.stdout).toContain(address);
  expect(result.stdout + result.stderr).not.toContain("SECRET-PLAN-VALUE");
});

test.each([
  "aws_cloudfront_distribution.frontend",
  "aws_dynamodb_table.meeting_history_table",
  "aws_ecs_service.app_service",
  "aws_ecs_task_definition.app_task",
  "aws_kms_key.app_general",
  "aws_kms_key_policy.app_general",
  "aws_iam_policy.dynamodb_policy",
])(
  "rejects unexpected managed changes to %s without exposing values",
  (address) => {
    const result = validate({ resource_changes: [kms, change(address)] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rejected");
    expect(result.stdout + result.stderr).not.toContain("SECRET-PLAN-VALUE");
  },
);

test.each(
  [
    ["delete"],
    ["delete", "create"],
    ["create", "delete"],
    ["forget"],
    [],
    ["read"],
    ["update", "no-op"],
  ].map((actions) => ({ actions })),
)("refuses unsupported managed actions $actions", ({ actions }) => {
  expect(
    validate({ resource_changes: [kms, change(targets[0], actions)] }).status,
  ).toBe(1);
});

test.each([
  null,
  {},
  { resource_changes: null },
  { resource_changes: {} },
  { resource_changes: [null] },
  { resource_changes: [{}] },
  {
    resource_changes: [
      kms,
      { address: targets[0], mode: "managed", change: { actions: "update" } },
    ],
  },
  { resource_changes: [kms, change(targets[0], ["update"], "invalid")] },
  {
    resource_changes: [
      kms,
      change("data.aws_caller_identity.current", ["update"], "data"),
    ],
  },
  { resource_changes: [] },
])("refuses malformed or missing action/key evidence %j", (input) => {
  expect(validate(input).status).toBe(1);
});

test.each([prerequisiteGuard, runtimeGuard, siteGuard])(
  "%s refuses invalid JSON with a sanitized error",
  (guard) => {
    const result = runPlanGuard(guard, "SECRET-PLAN-VALUE");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rejected");
    expect(result.stderr).not.toContain("SECRET-PLAN-VALUE");
  },
);

test.each([
  {
    name: "imported key no-op",
    resources: [
      {
        ...kms,
        change: { ...kms.change, importing: { id: "SECRET-PLAN-VALUE" } },
      },
    ],
  },
  {
    name: "imported standalone policy no-op",
    resources: [
      kms,
      {
        ...change("aws_kms_key_policy.app_general", ["no-op"]),
        change: { actions: ["no-op"], importing: { id: "SECRET-PLAN-VALUE" } },
      },
    ],
  },
  {
    name: "imported allowed target",
    resources: [
      kms,
      {
        ...change(targets[0]),
        change: { actions: ["update"], importing: { id: "SECRET-PLAN-VALUE" } },
      },
    ],
  },
  {
    name: "moved address no-op",
    resources: [
      kms,
      {
        ...change(targets[0], ["no-op"]),
        previous_address: "SECRET-PLAN-VALUE",
      },
    ],
  },
  {
    name: "import metadata on a data read",
    resources: [
      kms,
      {
        ...change("data.aws_caller_identity.current", ["read"], "data"),
        change: { actions: ["read"], importing: { id: "SECRET-PLAN-VALUE" } },
      },
    ],
  },
])("rejects $name without exposing state identifiers", ({ resources }) => {
  const result = validate({ resource_changes: resources });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("rejected");
  expect(result.stdout + result.stderr).not.toContain("SECRET-PLAN-VALUE");
});

test.each([false, 0, ""])("rejects non-null state metadata %j", (metadata) => {
  for (const resource of [
    { ...kms, change: { ...kms.change, importing: metadata } },
    { ...kms, previous_address: metadata },
  ]) {
    const result = validate({ resource_changes: [resource] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rejected");
  }
});

test("accepts explicit null state metadata as no import or move", () => {
  const result = validate({
    resource_changes: [
      {
        ...kms,
        previous_address: null,
        change: { ...kms.change, importing: null },
      },
    ],
  });
  expect(result.status).toBe(0);
});
