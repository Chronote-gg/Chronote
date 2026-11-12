/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEETING_ABANDONED_LOG,
  MEETING_DELIVERY_FAILED_LOG,
  MEETING_FINISH_FAILED_LOG,
  MEETING_FINISHER_SCAN_LOG,
  MEETING_STUCK_LOG,
  RENEWAL_RECOVERY_STALLED_LOG,
  TASK_PROTECTION_FAILED_LOG,
  WORKER_ELIGIBLE_LOG,
} from "../../src/metrics";
import { lifecycleAlarms } from "../../scripts/deployment/validate-processing-retry-plan.cjs";

const root = join(__dirname, "..", "..");
// A Windows checkout may carry CRLF; the line-anchored patterns below expect LF.
const read = (path: string) =>
  readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
const terraform = read("_infra/alerts-lifecycle.tf");
const deployScript = read("scripts/deployment/deploy.cjs");

const unescapeHcl = (value: string) => value.replaceAll('\\"', '"');
const capture = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((match) => match[1]);

// The `key = { ... }` entries of local.lifecycle_log_alarms, as attribute maps.
const terraformAlarms = new Map(
  [...terraform.matchAll(/^ {4}(\w+) = \{\n([\s\S]*?)\n {4}\}$/gm)].map(
    ([, key, body]) => [
      key,
      Object.fromEntries(
        [...body.matchAll(/^ {6}(\w+)\s*= (.*)$/gm)].map(([, name, value]) => [
          name,
          value.startsWith('"') ? unescapeHcl(value.slice(1, -1)) : value,
        ]),
      ),
    ],
  ),
);
const terraformPatterns = new Map(
  [...terraformAlarms].map(([key, alarm]) => [key, alarm.pattern]),
);
const quotedTerms = (pattern: string) => capture(pattern, /"([^"]+)"/g);
const alarmBlocks = terraform
  .split(/^resource "/m)
  .filter((block) => block.startsWith("aws_cloudwatch_metric_alarm"));

test("every alarm log constant has a filter with the identical string", () => {
  const terms = [...terraformPatterns.values()].flatMap(quotedTerms);
  for (const constant of [
    MEETING_STUCK_LOG,
    MEETING_ABANDONED_LOG,
    MEETING_FINISH_FAILED_LOG,
    MEETING_DELIVERY_FAILED_LOG,
    TASK_PROTECTION_FAILED_LOG,
    WORKER_ELIGIBLE_LOG,
    MEETING_FINISHER_SCAN_LOG,
    RENEWAL_RECOVERY_STALLED_LOG,
  ])
    expect(terms).toContain(constant);
});

test("the plan validator expects exactly the Terraform patterns", () => {
  expect(terraformPatterns.size).toBe(Object.keys(lifecycleAlarms).length);
  for (const [key, spec] of Object.entries(lifecycleAlarms))
    expect(terraformPatterns.get(key)).toBe(spec.pattern);
});

// Drift between these two would otherwise surface only as a refused production plan.
test("the plan validator expects exactly the Terraform alarm conditions", () => {
  for (const [key, spec] of Object.entries(lifecycleAlarms))
    expect(terraformAlarms.get(key)).toMatchObject({
      metric: spec.metric,
      threshold: String(spec.threshold),
      comparison: spec.comparison,
      evaluation_periods: String(spec.periods),
      treat_missing_data: spec.missing,
    });
  const lifecycleAlarm = alarmBlocks.find((block) =>
    block.startsWith('aws_cloudwatch_metric_alarm" "lifecycle"'),
  );
  // The validator fixes the statistic and period and requires every
  // evaluation period to breach.
  expect(lifecycleAlarm).toMatch(/^\s*statistic\s*= "Sum"$/m);
  expect(lifecycleAlarm).toMatch(/^\s*period\s*= 300$/m);
  expect(lifecycleAlarm).toMatch(
    /^\s*datapoints_to_alarm\s*= local\.lifecycle_log_alarms\[each\.key\]\.evaluation_periods$/m,
  );
  const drain = alarmBlocks.find((block) =>
    block.startsWith('aws_cloudwatch_metric_alarm" "deploy_drain_timeout"'),
  );
  for (const line of [
    /^\s*statistic\s*= "Sum"$/m,
    /^\s*period\s*= 300$/m,
    /^\s*evaluation_periods\s*= 1$/m,
    /^\s*threshold\s*= 1$/m,
    /^\s*comparison_operator\s*= "GreaterThanOrEqualToThreshold"$/m,
    /^\s*treat_missing_data\s*= "notBreaching"$/m,
  ])
    expect(drain).toMatch(line);
});

test("every alarm notifies the critical alerts topic", () => {
  expect(alarmBlocks).toHaveLength(2);
  for (const block of alarmBlocks)
    expect(block).toMatch(
      /^\s*alarm_actions\s*=\s*\[local\.critical_alerts_topic_arn\]$/m,
    );
});

test("the drain alarm watches the metric deploy.cjs publishes", () => {
  const [metric] = capture(deployScript, /const DRAIN_METRIC = "(\w+)";/g);
  const putMetric = deployScript.slice(
    deployScript.indexOf('"put-metric-data"'),
  );
  const [publishedNamespace] = capture(
    deployScript,
    /const namespace = `\$\{required\("SECRETS_PREFIX"\)\}(\/\w+)`;/g,
  );
  const drain = alarmBlocks.find((block) =>
    block.startsWith('aws_cloudwatch_metric_alarm" "deploy_drain_timeout"'),
  );
  expect(drain).toContain(`metric_name         = "${metric}"`);
  expect(drain).toContain(
    `namespace           = "\${local.name_prefix}${publishedNamespace}"`,
  );
  // An alarm on a dimensioned metric never sees a dimensionless datapoint.
  expect(putMetric.slice(0, putMetric.indexOf("});"))).not.toContain(
    "Dimensions",
  );
  expect(drain).not.toContain("dimensions");
  // deploy.cjs builds the namespace from SECRETS_PREFIX, which Terraform sets.
  expect(read("_infra/main.tf")).toMatch(
    /variable_name = "SECRETS_PREFIX"\s+value\s+= local\.name_prefix/,
  );
});
