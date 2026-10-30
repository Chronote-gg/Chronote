// Synthetic `terraform show -json` shape for the processing-retry scope: the
// delivered MeetingHistory table gaining the retry index, plus the new worker
// failure filter and alarm. The table values reuse the AWS 6.69.1 provider
// shape from the Sandbox delivery fixture, renamed per environment, with the
// AWS 6.70 unknown mask that recomputes every index's derived fields.
import providerPlan from "./terraformMeetingUpdate-provider.json";

export const retryAccountId = "123456789012";
export const tableAddress = "aws_dynamodb_table.meeting_history_table";
export const filterAddress =
  "aws_cloudwatch_log_metric_filter.processing_retry_worker_failed[0]";
export const alarmAddress =
  "aws_cloudwatch_metric_alarm.processing_retry_worker_failed[0]";
const prefixes = {
  production: "meeting-notes-prod",
  sandbox: "meeting-notes-sandbox",
};
const managed = (address, actions, change = {}) => ({
  address,
  mode: "managed",
  change: { actions, ...change },
});
const unchanged = (address) => managed(address, ["no-op"]);
const recomputedIndex = {
  key_schema: true,
  read_capacity: true,
  warm_throughput: true,
  write_capacity: true,
};

function tableChange(prefix) {
  const delivered = providerPlan.resource_changes[0].change.after;
  const before = JSON.parse(
    JSON.stringify(delivered).replaceAll("meeting-notes-sandbox", prefix),
  );
  const after = structuredClone(before);
  after.attribute.push(
    { name: "processingRetryDueAt", type: "N" },
    { name: "processingRetryQueue", type: "S" },
  );
  after.global_secondary_index.push({
    hash_key: "processingRetryQueue",
    key_schema: [],
    name: "ProcessingRetryDueIndex",
    non_key_attributes: null,
    on_demand_throughput: [],
    projection_type: "KEYS_ONLY",
    range_key: "processingRetryDueAt",
    read_capacity: null,
    warm_throughput: [],
    write_capacity: null,
  });
  // Unknown values are omitted from `after`, as `terraform show -json` does.
  for (const index of after.global_secondary_index)
    for (const key of Object.keys(recomputedIndex)) delete index[key];
  return managed(tableAddress, ["update"], {
    before,
    after,
    after_unknown: {
      global_secondary_index: after.global_secondary_index.map(() => ({
        ...recomputedIndex,
      })),
    },
  });
}

function filterChange(prefix) {
  return managed(filterAddress, ["create"], {
    before: null,
    after: {
      log_group_name: `/ecs/${prefix}-bot`,
      metric_transformation: [
        {
          default_value: null,
          dimensions: null,
          name: "ProcessingRetryWorkerFailed",
          namespace: `${prefix}/Logs`,
          unit: "None",
          value: "1",
        },
      ],
      name: `${prefix}-processing-retry-worker-failed`,
      pattern: '"Processing retry worker failed"',
      region: "us-east-1",
    },
    after_unknown: {
      apply_on_transformed_logs: true,
      id: true,
      metric_transformation: [{}],
    },
  });
}

function alarmChange(prefix) {
  const topic = `arn:aws:sns:us-east-1:${retryAccountId}:${prefix}-critical-alerts`;
  return managed(alarmAddress, ["create"], {
    before: null,
    after: {
      actions_enabled: true,
      alarm_actions: [topic],
      alarm_description: "The meeting processing retry worker hit a failure.",
      alarm_name: `${prefix}-processing-retry-worker-failed`,
      comparison_operator: "GreaterThanOrEqualToThreshold",
      datapoints_to_alarm: null,
      dimensions: null,
      evaluation_periods: 1,
      extended_statistic: null,
      insufficient_data_actions: null,
      metric_name: "ProcessingRetryWorkerFailed",
      metric_query: [],
      namespace: `${prefix}/Logs`,
      ok_actions: [topic],
      period: 300,
      region: "us-east-1",
      statistic: "Sum",
      tags: { Project: "meeting-notes-discord-bot" },
      threshold: 1,
      threshold_metric_id: null,
      treat_missing_data: "notBreaching",
      unit: null,
    },
    after_unknown: {
      alarm_actions: [false],
      arn: true,
      evaluate_low_sample_count_percentiles: true,
      id: true,
      metric_query: [],
      ok_actions: [false],
      tags: {},
      tags_all: true,
    },
  });
}

export function processingRetryPlan(environment = "production") {
  const prefix = prefixes[environment];
  return {
    format_version: "1.2",
    resource_changes: [
      {
        address: "data.aws_caller_identity.current",
        mode: "data",
        change: { actions: ["read"] },
      },
      unchanged("aws_kms_key.app_general"),
      tableChange(prefix),
      filterChange(prefix),
      alarmChange(prefix),
    ],
  };
}

// Sandbox without alerting: the counted filter and alarm have no instance, so
// the targeted graph is the table and its key.
export function quietSandboxPlan() {
  const plan = processingRetryPlan("sandbox");
  const dropped = new Set([filterAddress, alarmAddress]);
  plan.resource_changes = plan.resource_changes.filter(
    (r) => !dropped.has(r.address),
  );
  return plan;
}
