/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { captureMetricLines } from "../helpers/metricLines";
import {
  recordTranscriptionKeywordsRejected,
  recordTranscriptionMissingLogprobs,
} from "../../src/metrics";

const written = captureMetricLines();

// The alarms read the dimensionless series, so no model dimension is published.
test.each([
  [recordTranscriptionMissingLogprobs, "TranscriptionMissingLogprobs"],
  [recordTranscriptionKeywordsRejected, "TranscriptionKeywordsRejected"],
])("%p publishes the %s alarm metric", (record, metric) => {
  record("gpt-4o-transcribe");
  expect(written).toHaveLength(1);
  const line = JSON.parse(written[0]);
  expect(line[metric]).toBe(1);
  expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
});
