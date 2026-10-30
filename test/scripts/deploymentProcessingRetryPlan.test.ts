/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { validateProcessingRetryPlan } from "../../scripts/deployment/validate-processing-retry-plan.cjs";
import {
  alarmAddress,
  filterAddress,
  processingRetryPlan,
  quietSandboxPlan,
  retryAccountId,
  tableAddress,
} from "../fixtures/deployment/processingRetryPlan.js";
import {
  dropResource,
  findChange,
  forceUpdate,
  markAllNoOp,
  runPlanGuard,
} from "../fixtures/deployment/planGuard.js";

type Plan = ReturnType<typeof processingRetryPlan>;
type Environment = "production" | "sandbox";

const guard = "scripts/deployment/validate-processing-retry-plan.cjs";
const validate = (plan: Plan, environment: Environment = "production") =>
  validateProcessingRetryPlan(plan, { accountId: retryAccountId, environment });
const after = (plan: Plan, address: string) =>
  findChange(plan, address).change.after;
function rejected(mutate: (plan: Plan) => void, environment?: Environment) {
  const plan = processingRetryPlan(environment);
  mutate(plan);
  expect(() => validate(plan, environment)).toThrow();
}

test("accepts the production index, filter and alarm", () => {
  expect(validate(processingRetryPlan()).changes).toEqual([
    { address: tableAddress, action: "update" },
    { address: filterAddress, action: "create" },
    { address: alarmAddress, action: "create" },
  ]);
});

test("accepts Sandbox with or without alerting", () => {
  expect(
    validate(processingRetryPlan("sandbox"), "sandbox").changes,
  ).toHaveLength(3);
  expect(validate(quietSandboxPlan(), "sandbox").changes).toEqual([
    { address: tableAddress, action: "update" },
  ]);
});

test("accepts an already applied scope as no-ops", () => {
  expect(validate(markAllNoOp(processingRetryPlan())).changes).toEqual([]);
});

test("processing retry preserves unchanged known warm throughput on an existing index", () => {
  const plan = processingRetryPlan();
  const { before, after } = findChange(plan, tableAddress).change;
  for (const value of [before, after]) {
    const index = value.global_secondary_index.find(
      (index: { name: string }) => index.name === "GuildTimestampIndex",
    );
    index.warm_throughput = [
      { read_units_per_second: 1, write_units_per_second: 1 },
    ];
  }
  expect(() => validate(plan)).not.toThrow();
});

test("the CLI binds account and environment and explains the prerequisite", () => {
  const text = JSON.stringify(processingRetryPlan());
  expect(runPlanGuard(guard, text, [retryAccountId, "production"]).status).toBe(
    0,
  );
  for (const args of [
    [retryAccountId, "sandbox"],
    ["999999999999", "production"],
    [retryAccountId, "staging"],
  ]) {
    const result = runPlanGuard(guard, text, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apply the delivery index first");
  }
});

test("refuses two new indexes when the delivery index was never applied", () => {
  const plan = processingRetryPlan();
  const { before } = findChange(plan, tableAddress).change;
  before.global_secondary_index = before.global_secondary_index.filter(
    (index: { name: string }) => index.name !== "UpdateDeliveryDueIndex",
  );
  expect(() => validate(plan)).toThrow(
    "UpdateDeliveryDueIndex must be applied before processing-retry",
  );
});

test("refuses a before-state delivery index that differs from its definition", () => {
  const plan = processingRetryPlan();
  const { before } = findChange(plan, tableAddress).change;
  for (const index of before.global_secondary_index)
    if (index.name === "UpdateDeliveryDueIndex") index.projection_type = "ALL";
  expect(() => validate(plan)).toThrow();
});

test.each([filterAddress, alarmAddress])(
  "rejects %s in another region",
  (address) =>
    rejected((plan) => {
      after(plan, address).region = "us-west-2";
    }),
);

test("production must create or keep the alarm pair", () => {
  for (const address of [filterAddress, alarmAddress])
    rejected((plan) => dropResource(plan, address));
  rejected((plan) => {
    dropResource(plan, filterAddress);
    dropResource(plan, alarmAddress);
  });
  rejected((plan) => dropResource(plan, alarmAddress), "sandbox");
});

test.each([
  [tableAddress, ["delete", "create"]],
  [tableAddress, ["create"]],
  [filterAddress, ["update"]],
  [alarmAddress, ["delete"]],
])("rejects %s with actions %j", (address, actions) =>
  rejected((plan) => {
    findChange(plan, address).change.actions = actions;
  }),
);

test.each([
  "aws_kms_key.app_general",
  "aws_cloudwatch_log_group.app_log_group",
  "aws_sns_topic.critical_alerts[0]",
  "aws_kms_key_policy.app_general",
  "aws_cloudfront_distribution.frontend",
  "aws_dynamodb_table.guild_subscription_table",
])("rejects a change to %s outside the scope", (address) =>
  rejected((plan) => forceUpdate(plan, address)),
);

test("requires the KMS key as an unchanged dependency", () =>
  rejected((plan) => dropResource(plan, "aws_kms_key.app_general")));

test("refuses a KMS key policy create pulled into the targeted graph", () => {
  const plan = processingRetryPlan();
  plan.resource_changes.push({
    address: "aws_kms_key_policy.app_general",
    mode: "managed",
    change: { actions: ["create"] },
  });
  expect(() => validate(plan)).toThrow(
    "aws_kms_key_policy.app_general is outside the processing-retry closure",
  );
});

// The filter and alarm name the log group and topic, so a plan that still
// carries them means the graph edge to the KMS key policy came back.
test.each([
  "aws_cloudwatch_log_group.app_log_group",
  "aws_sns_topic.critical_alerts[0]",
  "aws_kms_key_policy.app_general",
])("refuses %s even as a no-op", (address) =>
  rejected((plan) => {
    plan.resource_changes.push({
      address,
      mode: "managed",
      change: { actions: ["no-op"] },
    });
  }),
);

test("accepts the AWS 6.70 table mask with computed warm_throughput", () => {
  const plan = processingRetryPlan();
  const mask = findChange(plan, tableAddress).change.after_unknown;
  expect(mask.global_secondary_index).toHaveLength(3);
  for (const index of mask.global_secondary_index)
    expect(index.warm_throughput).toBe(true);
  expect(validate(plan).changes).toHaveLength(3);
});

test("rejects a partially unknown warm_throughput as an unknown index effect", () => {
  const plan = processingRetryPlan();
  const mask = findChange(plan, tableAddress).change.after_unknown;
  mask.global_secondary_index[2].warm_throughput = [
    { read_units_per_second: true },
  ];
  expect(() => validate(plan)).toThrow("Unknown index effect");
});

// One index's unknown warm_throughput must not hide a known pre-warm change on
// another; the guild index keeps its known value only when it is unchanged.
test.each([
  ["unchanged", [], true],
  [
    "pre-warmed",
    [{ read_units_per_second: 50000, write_units_per_second: 20000 }],
    false,
  ],
])(
  "a known %s guild warm_throughput beside unknown ones",
  (_name, warm, ok) => {
    const plan = processingRetryPlan();
    const { after, after_unknown } = findChange(plan, tableAddress).change;
    const position = after.global_secondary_index.findIndex(
      (index: { name: string }) => index.name === "GuildTimestampIndex",
    );
    after.global_secondary_index[position].warm_throughput = warm;
    delete after_unknown.global_secondary_index[position].warm_throughput;
    if (ok) expect(validate(plan).changes).toHaveLength(3);
    else expect(() => validate(plan)).toThrow();
  },
);

type Values = ReturnType<typeof after>;
const retryIndex = (v: Values) => v.global_secondary_index.at(-1);
test.each([
  ["billing", (v: Values) => (v.billing_mode = "PROVISIONED")],
  ["recovery", (v: Values) => (v.point_in_time_recovery = [])],
  ["encryption", (v: Values) => (v.server_side_encryption = [])],
  ["stream", (v: Values) => (v.stream_enabled = true)],
  ["table name", (v: Values) => (v.name = "other")],
  [
    "extra attribute",
    (v: Values) => v.attribute.push({ name: "x", type: "S" }),
  ],
  ["dropped attribute", (v: Values) => v.attribute.shift()],
  [
    "edited guild index",
    (v: Values) => (v.global_secondary_index[0].projection_type = "KEYS_ONLY"),
  ],
  [
    "dropped delivery index",
    (v: Values) => v.global_secondary_index.splice(1, 1),
  ],
  ["retry projection", (v: Values) => (retryIndex(v).projection_type = "ALL")],
  ["retry keys", (v: Values) => (retryIndex(v).hash_key = "guildId")],
  ["retry index name", (v: Values) => (retryIndex(v).name = "Other")],
  [
    "second new index",
    (v: Values) =>
      v.global_secondary_index.push({ ...retryIndex(v), name: "Another" }),
  ],
])("rejects a table update with a changed %s", (_name, mutate) =>
  rejected((plan) => mutate(after(plan, tableAddress))),
);

test("rejects unknown table effects", () =>
  rejected((plan) => {
    findChange(plan, tableAddress).change.after_unknown = {
      server_side_encryption: true,
    };
  }));

test.each([
  ["pattern", (v: Values) => (v.pattern = "ERROR")],
  ["log group", (v: Values) => (v.log_group_name = "/ecs/other")],
  ["namespace", (v: Values) => (v.metric_transformation[0].namespace = "X")],
  ["metric", (v: Values) => (v.metric_transformation[0].name = "Other")],
  ["value", (v: Values) => (v.metric_transformation[0].value = "2")],
  [
    "dimensions",
    (v: Values) => (v.metric_transformation[0].dimensions = { a: "b" }),
  ],
  ["second transformation", (v: Values) => v.metric_transformation.push({})],
])("rejects a metric filter with a changed %s", (_name, mutate) =>
  rejected((plan) => mutate(after(plan, filterAddress))),
);

const otherTopic = `arn:aws:sns:us-east-1:${retryAccountId}:other`;
test.each([
  ["threshold", (v: Values) => (v.threshold = 5)],
  ["period", (v: Values) => (v.period = 60)],
  ["metric", (v: Values) => (v.metric_name = "Other")],
  ["namespace", (v: Values) => (v.namespace = "Other/Logs")],
  ["comparison", (v: Values) => (v.comparison_operator = "LessThanThreshold")],
  ["missing data", (v: Values) => (v.treat_missing_data = "breaching")],
  ["disabled actions", (v: Values) => (v.actions_enabled = false)],
  ["alarm action", (v: Values) => (v.alarm_actions = [otherTopic])],
  ["empty OK action", (v: Values) => (v.ok_actions = [])],
  [
    "insufficient data",
    (v: Values) => (v.insufficient_data_actions = [otherTopic]),
  ],
  ["name", (v: Values) => (v.alarm_name = "other")],
])("rejects an alarm with a changed %s", (_name, mutate) =>
  rejected((plan) => mutate(after(plan, alarmAddress))),
);

test.each([
  [filterAddress, { pattern: true }],
  [alarmAddress, { alarm_actions: true }],
])("rejects unknown create values on %s", (address, mask) =>
  rejected((plan) => {
    Object.assign(findChange(plan, address).change.after_unknown, mask);
  }),
);
