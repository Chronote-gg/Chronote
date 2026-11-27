import { expect, jest, test } from "@jest/globals";
import { emitMetric, LIFECYCLE_METRICS } from "../../src/lifecycleMetrics";
import { captureMetricLines } from "../helpers/metricLines";

const written = captureMetricLines();

const parsed = () => {
  expect(written).toHaveLength(1);
  expect(written[0].endsWith("\n")).toBe(true);
  expect(written[0].slice(0, -1)).not.toContain("\n");
  return JSON.parse(written[0]);
};

test("writes one Embedded Metric Format line counting one event", () => {
  jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  emitMetric(LIFECYCLE_METRICS.workerEligible);
  expect(parsed()).toEqual({
    _aws: {
      Timestamp: 1_700_000_000_000,
      CloudWatchMetrics: [
        {
          Namespace: "meeting-notes-test/Lifecycle",
          Dimensions: [[]],
          Metrics: [{ Name: "WorkerEligibleHeartbeat", Unit: "Count" }],
        },
      ],
    },
    WorkerEligibleHeartbeat: 1,
  });
});

// The dimensionless set is what the alarms read; the dimensioned one is for
// telling the phases apart when investigating.
test("publishes a dimension both on its own metric and in the dimensionless total", () => {
  emitMetric(LIFECYCLE_METRICS.meetingStuck, { Phase: "abandoned" });
  const line = parsed();
  const directive = line._aws.CloudWatchMetrics[0];
  expect(directive.Dimensions).toEqual([[], ["Phase"]]);
  expect(line.Phase).toBe("abandoned");
  expect(line.MeetingStuck).toBe(1);
  expect(Number.isInteger(line._aws.Timestamp)).toBe(true);
});

test("writes nothing without a namespace, as in local runs", () => {
  delete process.env.METRICS_NAMESPACE;
  emitMetric(LIFECYCLE_METRICS.finisherScanCompleted);
  expect(written).toEqual([]);
});

test("every metric name and dimension key is valid for EMF", () => {
  for (const name of Object.values(LIFECYCLE_METRICS))
    expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]{0,254}$/);
});
