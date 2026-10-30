"use strict";
const assert = require("node:assert/strict");
const {
  validateScopedPlan,
  runCli,
} = require("./validate-prerequisite-plan.cjs");
const {
  hasUnknown,
  named,
  validateIndex,
  tableDelta,
  deliveryIndex,
  without,
} = require("./terraform-meeting-update.cjs");

const table = "aws_dynamodb_table.meeting_history_table";
const metricFilter =
  "aws_cloudwatch_log_metric_filter.processing_retry_worker_failed[0]";
const alarm = "aws_cloudwatch_metric_alarm.processing_retry_worker_failed[0]";
const kmsKey = "aws_kms_key.app_general";
const processingRetryTargets = new Map([
  [table, ["update"]],
  [metricFilter, ["create"]],
  [alarm, ["create"]],
]);
const prefixes = {
  production: "meeting-notes-prod",
  sandbox: "meeting-notes-sandbox",
};
const retryAttributes = [
  { name: "processingRetryQueue", type: "S" },
  { name: "processingRetryDueAt", type: "N" },
];
const retryIndex = {
  name: "ProcessingRetryDueIndex",
  hash_key: "processingRetryQueue",
  range_key: "processingRetryDueAt",
  projection_type: "KEYS_ONLY",
};
const metric = { name: "ProcessingRetryWorkerFailed", value: "1" };
const alarmSettings = {
  metric_name: metric.name,
  statistic: "Sum",
  period: 300,
  evaluation_periods: 1,
  threshold: 1,
  comparison_operator: "GreaterThanOrEqualToThreshold",
  treat_missing_data: "notBreaching",
  actions_enabled: true,
};
const empty = (value) => value == null || Object.keys(value).length === 0;
// A create may leave unknown only the fields AWS 6.70 learns on creation.
const knownExcept = (change, outputs) =>
  assert.ok(!hasUnknown(without(change.after_unknown ?? {}, outputs)));

// Two new indexes at once means the delivery index was never applied; that
// belongs to its own reviewed change, not this scope.
function checkTable(change, names) {
  const indexes = named(change.before.global_secondary_index);
  assert.ok(
    indexes.has(deliveryIndex.name),
    "UpdateDeliveryDueIndex must be applied before processing-retry",
  );
  validateIndex(indexes.get(deliveryIndex.name), deliveryIndex);
  assert.ok(indexes.has("GuildTimestampIndex"));
  tableDelta(change, {
    name: names.table,
    arn: names.tableArn,
    attributes: retryAttributes,
    index: retryIndex,
  });
}

function checkMetricFilter(change, names) {
  knownExcept(change, ["id", "apply_on_transformed_logs"]);
  const { after } = change;
  assert.equal(after.name, names.failure);
  assert.equal(after.log_group_name, names.logGroup);
  assert.equal(after.region, "us-east-1");
  assert.equal(after.pattern, '"Processing retry worker failed"');
  const [transformation, ...extra] = after.metric_transformation;
  assert.equal(extra.length, 0);
  assert.deepEqual(
    without(transformation, ["default_value", "dimensions", "unit"]),
    { ...metric, namespace: names.namespace },
  );
  assert.equal(transformation.default_value ?? null, null);
  assert.ok(empty(transformation.dimensions));
  assert.ok([null, undefined, "None"].includes(transformation.unit));
}

function checkAlarm(change, names) {
  knownExcept(change, [
    "arn",
    "id",
    "evaluate_low_sample_count_percentiles",
    "tags_all",
  ]);
  const { after } = change;
  assert.equal(after.alarm_name, names.failure);
  assert.equal(after.namespace, names.namespace);
  assert.equal(after.region, "us-east-1");
  for (const [key, value] of Object.entries(alarmSettings))
    assert.equal(after[key], value);
  assert.deepEqual(after.alarm_actions, [names.topicArn]);
  assert.deepEqual(after.ok_actions, [names.topicArn]);
  assert.ok(empty(after.insufficient_data_actions));
  assert.ok(empty(after.dimensions));
  assert.ok(empty(after.metric_query));
  assert.equal(after.extended_statistic ?? null, null);
  assert.equal(after.threshold_metric_id ?? null, null);
}

// The filter and alarm name the log group and topic instead of referencing
// them, so the targeted graph is the targets plus the table's key. Anything
// else, such as the KMS key policy, means that decoupling regressed.
function assertClosure(plan) {
  const closure = new Set([...processingRetryTargets.keys(), kmsKey]);
  for (const { address, mode } of plan.resource_changes)
    assert.ok(
      mode !== "managed" || closure.has(address),
      `${address} is outside the processing-retry closure`,
    );
}

function present(plan, address) {
  return plan.resource_changes.some((r) => r.address === address);
}

// Production always alarms. Sandbox may run without alerting, in which case
// the counted filter and alarm have no instance and must both be absent.
function alerting(plan, environment) {
  const pair = [metricFilter, alarm].map((a) => present(plan, a));
  assert.equal(pair[0], pair[1]);
  assert.ok(pair[0] || environment === "sandbox");
  return pair[0];
}

function validateProcessingRetryPlan(plan, { accountId, environment }) {
  assert.match(accountId, /^\d{12}$/);
  const prefix = prefixes[environment];
  assert.ok(prefix);
  assert.ok(plan && Array.isArray(plan.resource_changes));
  const names = {
    table: `${prefix}-MeetingHistoryTable`,
    tableArn: `arn:aws:dynamodb:us-east-1:${accountId}:table/${prefix}-MeetingHistoryTable`,
    failure: `${prefix}-processing-retry-worker-failed`,
    logGroup: `/ecs/${prefix}-bot`,
    namespace: `${prefix}/Logs`,
    topicArn: `arn:aws:sns:us-east-1:${accountId}:${prefix}-critical-alerts`,
  };
  assert.ok(present(plan, table));
  assertClosure(plan);
  alerting(plan, environment);
  const checks = {
    [table]: (change) => checkTable(change, names),
    [metricFilter]: (change) => checkMetricFilter(change, names),
    [alarm]: (change) => checkAlarm(change, names),
  };
  return validateScopedPlan(plan, {
    targets: processingRetryTargets,
    requiredNoOp: [kmsKey],
    check: ({ address, change }) => checks[address](change),
  });
}
module.exports = { validateProcessingRetryPlan, processingRetryTargets };
if (require.main === module)
  runCli(
    (plan) =>
      validateProcessingRetryPlan(plan, {
        accountId: process.argv[2],
        environment: process.argv[3],
      }),
    "Processing retry plan rejected: invalid action evidence, changes outside the processing-retry scope, or a missing UpdateDeliveryDueIndex (apply the delivery index first).\n",
  );
