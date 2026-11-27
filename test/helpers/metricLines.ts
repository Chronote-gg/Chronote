import { afterEach, beforeEach, jest } from "@jest/globals";

/**
 * Captures the Embedded Metric Format lines written to stdout in each test,
 * with a metrics namespace set so `emitMetric` writes them.
 */
export function captureMetricLines(): string[] {
  const written: string[] = [];
  beforeEach(() => {
    written.length = 0;
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
  return written;
}
