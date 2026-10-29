import type { metricsRegistry as registry } from "../metrics";
export function expectNoSpeechComparisonMetrics(
  metricsRegistry: typeof registry,
) {
  // These workloads do not participate in Discord snippet comparisons.
  beforeEach(() => metricsRegistry.resetMetrics());
  afterEach(async () => {
    const comparisonMetrics = await Promise.all(
      metricsRegistry
        .getMetricsAsArray()
        .filter((metric) =>
          metric.name.startsWith("chronote_speech_detection_"),
        )
        .map((metric) => metricsRegistry.getSingleMetric(metric.name)?.get()),
    );
    expect(
      comparisonMetrics
        .flatMap((metric) => metric?.values ?? [])
        .every((value) => value.value === 0),
    ).toBe(true);
  });
}
