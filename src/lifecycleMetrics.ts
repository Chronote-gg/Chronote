// Lifecycle alarm metrics, published as CloudWatch Embedded Metric Format.
// The awslogs driver ships each stdout line to the app log group through
// PutLogEvents. AWS documents the json/emf header on that call as optional,
// and extraction needs a Standard-class log group, so no agent and no
// PutMetricData permission is involved. Extraction from the awslogs driver is
// confirmed only by the post-deploy check in docs/terraform-delivery.md.
// Terraform alarms on these names in METRICS_NAMESPACE
// (_infra/alerts-lifecycle.tf); test/scripts/lifecycleAlarms.test.ts keeps
// both sides identical.
export const LIFECYCLE_METRICS = {
  // Phase: open (unfinished past the alarm age), abandoned, or delivery (a
  // finished meeting whose Discord delivery has kept failing for over an hour).
  meetingStuck: "MeetingStuck",
  // Phase: finish or delivery, after their retries ran out.
  meetingFailed: "MeetingFailed",
  taskProtectionFailed: "TaskProtectionFailed",
  workerEligible: "WorkerEligibleHeartbeat",
  finisherScanCompleted: "FinisherScanCompleted",
  renewalRecoveryStalled: "RenewalRecoveryStalled",
  // An ASR response with text but no logprobs, so the quiet-audio guard is off.
  transcriptionMissingLogprobs: "TranscriptionMissingLogprobs",
  // HTTP 400 to a request carrying dictionary keywords, retried without them.
  transcriptionKeywordsRejected: "TranscriptionKeywordsRejected",
  // The speech detector killed its child (a hang, crash or invalid output).
  speechDetectorRetired: "SpeechDetectorRetired",
  // The transcription queue refused a slow-pass snippet (fast sheds excluded).
  transcriptionSlowPassRejected: "TranscriptionSlowPassRejected",
  // A meeting completed without a summary after the in-attempt retry.
  meetingSummaryDropped: "MeetingSummaryDropped",
  // Every speech assessment result, and every unavailable one (any reason).
  speechAssessmentAttempted: "SpeechAssessmentAttempted",
  speechAssessmentUnavailable: "SpeechAssessmentUnavailable",
} as const;

export type LifecycleMetric =
  (typeof LIFECYCLE_METRICS)[keyof typeof LIFECYCLE_METRICS];

/**
 * Counts one event. Dimensions must be low-cardinality enums, never meeting,
 * guild or user ids; the metric is also published without them, which is the
 * series the alarms read.
 */
export function emitMetric(
  name: LifecycleMetric,
  dimensions: Record<string, string> = {},
): void {
  const namespace = process.env.METRICS_NAMESPACE;
  if (!namespace) return;
  const keys = Object.keys(dimensions);
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: keys.length ? [[], keys] : [[]],
          Metrics: [{ Name: name, Unit: "Count" }],
        },
      ],
    },
    ...dimensions,
    [name]: 1,
  };
  process.stdout.write(JSON.stringify(line) + "\n");
}
