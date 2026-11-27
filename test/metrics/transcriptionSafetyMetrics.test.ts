/** @jest-environment node */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import {
  recordTranscriptionKeywordsRejected,
  recordTranscriptionMissingLogprobs,
} from "../../src/metrics";

let written: string[];
beforeEach(() => {
  written = [];
  jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  process.env.METRICS_NAMESPACE = "meeting-notes-test/Lifecycle";
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.METRICS_NAMESPACE;
});

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
