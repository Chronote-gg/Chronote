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
const notBreaching = "notBreaching";
const atLeast = "GreaterThanOrEqualToThreshold";
// Mirrors _infra/alerts-lifecycle.tf. The patterns must stay byte-identical to
// the *_LOG constants in src/metrics.ts; lifecycleAlarms.test.ts checks both.
const lifecycleAlarms = {
  meeting_lifecycle_stuck: {
    pattern: '?"Meeting lifecycle stuck" ?"Meeting lifecycle abandoned"',
    metric: "MeetingLifecycleStuck",
    threshold: 1,
    comparison: atLeast,
    periods: 1,
    missing: notBreaching,
  },
  meeting_finish_failed: {
    pattern:
      '?"Meeting finish failed after retries" ?"Meeting delivery failed after retries"',
    metric: "MeetingFinishFailed",
    threshold: 1,
    comparison: atLeast,
    periods: 1,
    missing: notBreaching,
  },
  task_protection_failing: {
    pattern: '"Task protection failed during capture"',
    metric: "TaskProtectionFailed",
    threshold: 3,
    comparison: atLeast,
    periods: 1,
    missing: notBreaching,
  },
  no_eligible_worker: {
    pattern: '"Worker eligible heartbeat"',
    metric: "WorkerEligibleHeartbeat",
    threshold: 1,
    comparison: "LessThanThreshold",
    periods: 1,
    missing: "breaching",
  },
  finisher_scan_missing: {
    pattern: '"Meeting finisher scan completed"',
    metric: "MeetingFinisherScanCompleted",
    threshold: 1,
    comparison: "LessThanThreshold",
    periods: 2,
    missing: "breaching",
  },
  renewal_recovery_stalled: {
    pattern: '"Renewal recovery poll skipped after a lease error"',
    metric: "RenewalRecoveryStalled",
    threshold: 1,
    comparison: atLeast,
    periods: 3,
    missing: notBreaching,
  },
};
const lifecycleFilter = (key) =>
  `aws_cloudwatch_log_metric_filter.lifecycle["${key}"]`;
const lifecycleAlarm = (key) =>
  `aws_cloudwatch_metric_alarm.lifecycle["${key}"]`;
const drainAlarm = "aws_cloudwatch_metric_alarm.deploy_drain_timeout[0]";
const drainMetric = "DrainWaitTimedOut";
const lifecycleAddresses = [
  ...Object.keys(lifecycleAlarms).flatMap((key) => [
    lifecycleFilter(key),
    lifecycleAlarm(key),
  ]),
  drainAlarm,
];
const processingRetryTargets = new Map([
  [table, ["update"]],
  [metricFilter, ["create"]],
  [alarm, ["create"]],
  ...lifecycleAddresses.map((address) => [address, ["create"]]),
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
const retryAlarm = {
  pattern: '"Processing retry worker failed"',
  metric: "ProcessingRetryWorkerFailed",
  threshold: 1,
  comparison: atLeast,
  periods: 1,
  missing: notBreaching,
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

function checkMetricFilter(change, names, name, spec) {
  knownExcept(change, ["id", "apply_on_transformed_logs"]);
  const { after } = change;
  assert.equal(after.name, name);
  assert.equal(after.log_group_name, names.logGroup);
  assert.equal(after.region, "us-east-1");
  assert.equal(after.pattern, spec.pattern);
  const [transformation, ...extra] = after.metric_transformation;
  assert.equal(extra.length, 0);
  assert.deepEqual(
    without(transformation, ["default_value", "dimensions", "unit"]),
    { name: spec.metric, value: "1", namespace: names.namespace },
  );
  assert.equal(transformation.default_value ?? null, null);
  assert.ok(empty(transformation.dimensions));
  assert.ok([null, undefined, "None"].includes(transformation.unit));
}

// An unset datapoints_to_alarm means every evaluation period, as equal does.
function checkAlarm(change, names, alarmName, namespace, spec) {
  knownExcept(change, [
    "arn",
    "id",
    "evaluate_low_sample_count_percentiles",
    "tags_all",
  ]);
  const { after } = change;
  assert.equal(after.alarm_name, alarmName);
  assert.equal(after.namespace, namespace);
  assert.equal(after.region, "us-east-1");
  const settings = {
    metric_name: spec.metric,
    statistic: "Sum",
    period: 300,
    evaluation_periods: spec.periods,
    threshold: spec.threshold,
    comparison_operator: spec.comparison,
    treat_missing_data: spec.missing,
    actions_enabled: true,
  };
  for (const [key, value] of Object.entries(settings))
    assert.equal(after[key], value);
  assert.ok([null, spec.periods].includes(after.datapoints_to_alarm ?? null));
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
// the counted filter and alarm have no instance and must both be absent. A plan
// from source before the lifecycle alarms has none of them; any other plan has
// all of them, exactly when the retry pair is present, except that a parked
// Sandbox (desired count 0) omits the pairs that alarm on worker silence.
// Production cannot park, because ECS_DESIRED_COUNT refuses 0 there.
const parkedAddresses = ["no_eligible_worker", "finisher_scan_missing"].flatMap(
  (key) => [lifecycleFilter(key), lifecycleAlarm(key)],
);
function alerting(plan, environment) {
  const pair = [metricFilter, alarm].map((a) => present(plan, a));
  assert.equal(pair[0], pair[1]);
  assert.ok(pair[0] || environment === "sandbox");
  const missing = lifecycleAddresses.filter((a) => !present(plan, a));
  const parked =
    environment === "sandbox" &&
    missing.length === parkedAddresses.length &&
    parkedAddresses.every((a) => missing.includes(a));
  assert.ok(
    missing.length === lifecycleAddresses.length ||
      (pair[0] && (missing.length === 0 || parked)),
  );
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
    [metricFilter]: (change) =>
      checkMetricFilter(change, names, names.failure, retryAlarm),
    [alarm]: (change) =>
      checkAlarm(change, names, names.failure, names.namespace, retryAlarm),
    [drainAlarm]: (change) =>
      checkAlarm(
        change,
        names,
        `${prefix}-deploy-drain-timeout`,
        `${prefix}/Deploy`,
        { ...retryAlarm, metric: drainMetric },
      ),
  };
  for (const [key, spec] of Object.entries(lifecycleAlarms)) {
    const name = `${prefix}-${key.replaceAll("_", "-")}`;
    checks[lifecycleFilter(key)] = (change) =>
      checkMetricFilter(change, names, name, spec);
    checks[lifecycleAlarm(key)] = (change) =>
      checkAlarm(change, names, name, names.namespace, spec);
  }
  return validateScopedPlan(plan, {
    targets: processingRetryTargets,
    requiredNoOp: [kmsKey],
    check: ({ address, change }) => checks[address](change),
  });
}
module.exports = {
  validateProcessingRetryPlan,
  processingRetryTargets,
  lifecycleAlarms,
  drainMetric,
};
if (require.main === module)
  runCli(
    (plan) =>
      validateProcessingRetryPlan(plan, {
        accountId: process.argv[2],
        environment: process.argv[3],
      }),
    "Processing retry plan rejected: invalid action evidence, changes outside the processing-retry scope, or a missing UpdateDeliveryDueIndex (apply the delivery index first).\n",
  );
