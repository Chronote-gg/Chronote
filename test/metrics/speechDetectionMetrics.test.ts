/** @jest-environment node */
import * as metrics from "../../src/metrics";
import type { SpeechAssessment } from "../../src/services/speechDetectionTypes";

const assessment = {
  kind: "non_speech",
  policyFingerprint: "private-policy",
  metrics: {
    peakSpeechProbability: 0.1,
    maxConsecutiveSpeechFrames: 0,
    scannedFrames: 10,
    totalFrames: 10,
    gain: 2,
  },
} satisfies SpeechAssessment;

async function samples(name: string) {
  const metric = metrics.metricsRegistry.getSingleMetric(
    `chronote_speech_detection_${name}`,
  );
  expect(metric).toBeDefined();
  if (!metric) throw Error(`Missing metric ${name}`);
  return (await metric.get()).values;
}
beforeEach(() => metrics.metricsRegistry.resetMetrics());

it("records unavailable and nonspeech assessments without treating them as actual skips", async () => {
  metrics.recordSpeechAssessment({
    mode: "enforce",
    phase: "fast",
    assessment,
    durationMs: 250,
  });
  metrics.recordSpeechAssessment({
    mode: "shadow",
    phase: "slow",
    assessment: {
      kind: "unavailable",
      reason: "queue_full",
      policyFingerprint: "secret",
    },
    durationMs: 50,
  });
  expect(await samples("assessments_total")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: 1,
        labels: {
          mode: "enforce",
          phase: "fast",
          kind: "non_speech",
          reason: "none",
        },
      }),
      expect.objectContaining({
        value: 1,
        labels: {
          mode: "shadow",
          phase: "slow",
          kind: "unavailable",
          reason: "queue_full",
        },
      }),
    ]),
  );
  expect(await samples("requests_skipped_total")).toEqual([]);
  expect(await samples("skipped_audio_seconds_total")).toEqual([]);
  expect(await samples("queue_saturation_total")).toContainEqual(
    expect.objectContaining({ value: 1, labels: { phase: "slow" } }),
  );
  expect(await samples("assessment_duration_seconds")).toContainEqual(
    expect.objectContaining({
      metricName: "chronote_speech_detection_assessment_duration_seconds_sum",
      value: 0.25,
      labels: { mode: "enforce", phase: "fast" },
    }),
  );
  metrics.recordSpeechRequestSkipped({ phase: "fast", audioSeconds: 3 });
  expect(await samples("requests_skipped_total")).toContainEqual(
    expect.objectContaining({ value: 1, labels: { phase: "fast" } }),
  );
  expect(await samples("skipped_audio_seconds_total")).toContainEqual(
    expect.objectContaining({ value: 3, labels: { phase: "fast" } }),
  );
});

it("records comparison events independently of detection and counts both voting candidates", async () => {
  metrics.recordSpeechCapturedAudio({ mode: "off", audioSeconds: 10 });
  metrics.recordSpeechSnippetOutcome({
    mode: "off",
    phase: "fast",
    outcome: "transcribed",
    audioSeconds: 2,
    durationMs: 500,
  });
  metrics.recordSpeechProviderSubmission({
    mode: "off",
    phase: "fast",
    candidate: "prompt",
    audioSeconds: 2,
  });
  metrics.recordSpeechProviderSubmission({
    mode: "shadow",
    phase: "slow",
    candidate: "prompt",
    audioSeconds: 3,
  });
  metrics.recordSpeechProviderSubmission({
    mode: "shadow",
    phase: "slow",
    candidate: "no_prompt",
    audioSeconds: 3,
  });
  metrics.recordSpeechSnippetOutcome({
    mode: "shadow",
    phase: "slow",
    outcome: "provider_error",
    audioSeconds: 3,
    durationMs: 1000,
  });
  metrics.recordSpeechSnippetOutcome({
    mode: "enforce",
    phase: "slow",
    outcome: "reused",
    audioSeconds: 4,
    durationMs: 0,
  });
  metrics.recordSpeechSnippetOutcome({
    mode: "enforce",
    phase: "slow",
    outcome: "vad_skipped",
    audioSeconds: 4,
    durationMs: 10,
  });
  expect(
    (await samples("provider_submissions_total")).map((sample) => sample.value),
  ).toEqual([1, 1, 1]);
  expect(
    (await samples("submitted_audio_seconds_total")).map(
      (sample) => sample.value,
    ),
  ).toEqual([2, 3, 3]);
  expect(await samples("captured_audio_seconds_total")).toContainEqual(
    expect.objectContaining({ value: 10, labels: { mode: "off" } }),
  );
  expect(await samples("snippet_outcomes_total")).toHaveLength(4);
  expect(await samples("end_to_end_duration_seconds")).toContainEqual(
    expect.objectContaining({
      metricName: "chronote_speech_detection_end_to_end_duration_seconds_sum",
      value: 0.5,
      labels: { mode: "off", phase: "fast", outcome: "transcribed" },
    }),
  );
});

it("exposes fixed label names and no content or policy fields", async () => {
  metrics.recordSpeechAssessment({
    mode: "enforce",
    phase: "slow",
    assessment,
    durationMs: 1,
  });
  metrics.recordSpeechWorkerRestart();
  expect(await samples("worker_restarts_total")).toContainEqual(
    expect.objectContaining({ value: 1, labels: {} }),
  );
  const registered = (await metrics.metricsRegistry.getMetricsAsJSON()).filter(
    (entry) => entry.name.startsWith("chronote_speech_detection_"),
  );
  expect(new Set(registered.map((entry) => entry.name)).size).toBe(
    registered.length,
  );
  for (const metric of registered)
    for (const sample of metric.values) {
      expect(
        Object.keys(sample.labels).every((label) =>
          [
            "mode",
            "phase",
            "kind",
            "reason",
            "candidate",
            "outcome",
            "le",
          ].includes(label),
        ),
      ).toBe(true);
    }
  expect(JSON.stringify(registered)).not.toContain("private-policy");
});
