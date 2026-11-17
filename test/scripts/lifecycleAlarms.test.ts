/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIFECYCLE_METRICS } from "../../src/lifecycleMetrics";

const root = join(__dirname, "..", "..");
// A Windows checkout may carry CRLF; the line-anchored patterns below expect LF.
const read = (path: string) =>
  readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
const terraform = read("_infra/alerts-lifecycle.tf");
const deployScript = read("scripts/deployment/deploy.cjs");

const capture = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((match) => match[1]);
const alarmBlocks = terraform
  .split(/^resource "/m)
  .filter((block) => block.startsWith("aws_cloudwatch_metric_alarm"));

const sourceFiles = (directory: string): string[] =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (statSync(join(root, path)).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
// Keys of LIFECYCLE_METRICS that some src file passes to emitMetric.
const emitted = new Set(
  sourceFiles("src").flatMap((path) =>
    capture(read(path), /emitMetric\(\s*LIFECYCLE_METRICS\.(\w+)/g),
  ),
);
const alarmMetrics = capture(terraform, /^\s+metric\s+= "(\w+)"$/gm);

test("every alarm reads a metric the code emits, and every emitted metric has an alarm", () => {
  const names = Object.values(LIFECYCLE_METRICS);
  expect([...alarmMetrics].sort()).toEqual([...names].sort());
  expect([...emitted].sort()).toEqual(Object.keys(LIFECYCLE_METRICS).sort());
});

test("no lifecycle alarm depends on log wording", () => {
  expect(terraform).not.toContain("aws_cloudwatch_log_metric_filter");
  expect(terraform).not.toMatch(/pattern\s*=/);
});

test("the runtime publishes into the namespace the alarms read", () => {
  expect(terraform).toMatch(
    /lifecycle_metrics_namespace = "\$\{local\.name_prefix\}\/Lifecycle"/,
  );
  expect(read("_infra/main.tf")).toMatch(
    /name\s+= "METRICS_NAMESPACE"\s+value\s+= local\.lifecycle_metrics_namespace/,
  );
});

// Essentials (Infrequent Access) log groups do not extract embedded metrics.
test("the app log group stays in the Standard class", () => {
  const group = read("_infra/main.tf").match(
    /resource "aws_cloudwatch_log_group" "app_log_group" \{([\s\S]*?)\n\}/,
  )?.[1];
  expect(group).toMatch(/log_group_class\s*= "STANDARD"/);
});

test("the two heartbeats alarm on silence", () => {
  for (const metric of [
    LIFECYCLE_METRICS.workerEligible,
    LIFECYCLE_METRICS.finisherScanCompleted,
  ]) {
    const entry = terraform.match(
      new RegExp(`\\{\\n([^}]*metric\\s+= "${metric}"[^}]*)\\}`),
    )?.[1];
    expect(entry).toMatch(/comparison\s+= "LessThanThreshold"/);
    expect(entry).toMatch(/treat_missing_data = "breaching"/);
  }
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
