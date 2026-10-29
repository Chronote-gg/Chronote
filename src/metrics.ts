import {
  Registry,
  collectDefaultMetrics,
  Histogram,
  Counter,
} from "prom-client";
import type { NextFunction, Request, Response } from "express";
import type { SpeechDetectionMode } from "./config/speechDetection";
import type {
  SpeechAssessment,
  SpeechPhase,
} from "./services/speechDetectionTypes";

// Single global registry for the process
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

// HTTP request duration histogram
const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

// Basic app-level counters we can increment from other modules
export const meetingsStarted = new Counter({
  name: "meeting_started_total",
  help: "Total meetings started",
  registers: [metricsRegistry],
});

export const meetingsCancelled = new Counter({
  name: "meeting_cancelled_total",
  help: "Total meetings cancelled due to low content",
  registers: [metricsRegistry],
});

export const liveVoiceResponses = new Counter({
  name: "live_voice_responses_total",
  help: "Total live voice responses spoken",
  registers: [metricsRegistry],
});

export const chatTtsEnqueued = new Counter({
  name: "chat_tts_enqueued_total",
  help: "Total chat-to-speech messages enqueued",
  registers: [metricsRegistry],
});

export const chatTtsSpoken = new Counter({
  name: "chat_tts_spoken_total",
  help: "Total chat-to-speech messages spoken",
  registers: [metricsRegistry],
});

export const chatTtsDropped = new Counter({
  name: "chat_tts_dropped_total",
  help: "Total chat-to-speech messages dropped",
  registers: [metricsRegistry],
});

export const chatTtsMonthlyLimitBlocked = new Counter({
  name: "chat_tts_monthly_limit_blocked_total",
  help: "Total chat-to-speech messages blocked by monthly usage limits",
  registers: [metricsRegistry],
});

const speechAssessments = new Counter({
  name: "chronote_speech_detection_assessments_total",
  help: "Speech detector assessments, including unavailable results",
  labelNames: ["mode", "phase", "kind", "reason"],
  registers: [metricsRegistry],
});
const speechAssessmentDuration = new Histogram({
  name: "chronote_speech_detection_assessment_duration_seconds",
  help: "Speech assessment duration including queue time in seconds",
  labelNames: ["mode", "phase"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 3],
  registers: [metricsRegistry],
});
const speechQueueSaturation = new Counter({
  name: "chronote_speech_detection_queue_saturation_total",
  help: "Speech assessments unavailable because the worker queue was full",
  labelNames: ["phase"],
  registers: [metricsRegistry],
});
const speechWorkerRestarts = new Counter({
  name: "chronote_speech_detection_worker_restarts_total",
  help: "Speech worker generations started after the first generation",
  registers: [metricsRegistry],
});
const speechRequestsSkipped = new Counter({
  name: "chronote_speech_detection_requests_skipped_total",
  help: "Requests actually skipped by enforced nonspeech admission",
  labelNames: ["phase"],
  registers: [metricsRegistry],
});
const speechAudioSkipped = new Counter({
  name: "chronote_speech_detection_skipped_audio_seconds_total",
  help: "Audio seconds actually skipped by enforced nonspeech admission",
  labelNames: ["phase"],
  registers: [metricsRegistry],
});
const speechSnippetOutcomes = new Counter({
  name: "chronote_speech_detection_snippet_outcomes_total",
  help: "Discord snippet outcomes in every speech detection mode",
  labelNames: ["mode", "phase", "outcome"],
  registers: [metricsRegistry],
});
const speechProviderSubmissions = new Counter({
  name: "chronote_speech_detection_provider_submissions_total",
  help: "Application provider SDK invocations including voting and failed submissions",
  labelNames: ["mode", "phase", "candidate"],
  registers: [metricsRegistry],
});
const speechSubmittedAudio = new Counter({
  name: "chronote_speech_detection_submitted_audio_seconds_total",
  help: "Audio seconds passed to application provider SDK invocations",
  labelNames: ["mode", "phase", "candidate"],
  registers: [metricsRegistry],
});
const speechCapturedAudio = new Counter({
  name: "chronote_speech_detection_captured_audio_seconds_total",
  help: "Decoded recording seconds independent of admission decisions",
  labelNames: ["mode"],
  registers: [metricsRegistry],
});
const speechEndToEndDuration = new Histogram({
  name: "chronote_speech_detection_end_to_end_duration_seconds",
  help: "Discord snippet processing duration in seconds",
  labelNames: ["mode", "phase", "outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export function recordSpeechAssessment(input: {
  mode: SpeechDetectionMode;
  phase: SpeechPhase;
  assessment: SpeechAssessment;
  durationMs: number;
}): void {
  const { mode, phase, assessment, durationMs } = input;
  speechAssessments.inc({
    mode,
    phase,
    kind: assessment.kind,
    reason: assessment.kind === "unavailable" ? assessment.reason : "none",
  });
  speechAssessmentDuration.observe({ mode, phase }, durationMs / 1000);
  if (assessment.kind === "unavailable" && assessment.reason === "queue_full") {
    speechQueueSaturation.inc({ phase });
  }
}

// Call only after admission actually skips an enforce-mode request.
export function recordSpeechRequestSkipped(input: {
  phase: SpeechPhase;
  audioSeconds: number;
}): void {
  speechRequestsSkipped.inc({ phase: input.phase });
  speechAudioSkipped.inc({ phase: input.phase }, input.audioSeconds);
}

export function recordSpeechSnippetOutcome(input: {
  mode: SpeechDetectionMode;
  phase: SpeechPhase;
  outcome:
    | "transcribed"
    | "reused"
    | "vad_skipped"
    | "conversion_error"
    | "provider_error";
  audioSeconds: number;
  durationMs: number;
}): void {
  const labels = {
    mode: input.mode,
    phase: input.phase,
    outcome: input.outcome,
  };
  speechSnippetOutcomes.inc(labels);
  speechEndToEndDuration.observe(labels, input.durationMs / 1000);
}

export function recordSpeechProviderSubmission(input: {
  mode: SpeechDetectionMode;
  phase: SpeechPhase;
  candidate: "prompt" | "no_prompt";
  audioSeconds: number;
}): void {
  const labels = {
    mode: input.mode,
    phase: input.phase,
    candidate: input.candidate,
  };
  speechProviderSubmissions.inc(labels);
  speechSubmittedAudio.inc(labels, input.audioSeconds);
}

export function recordSpeechCapturedAudio(input: {
  mode: SpeechDetectionMode;
  audioSeconds: number;
}): void {
  speechCapturedAudio.inc({ mode: input.mode }, input.audioSeconds);
}

export function recordSpeechWorkerRestart(): void {
  speechWorkerRestarts.inc();
}

// Outcomes of the billing read-path release of a provider-expired checkout lock.
// Dimensionless by design: guild-level detail goes to logs, never labels.
export const checkoutLockReleases = new Counter({
  name: "checkout_lock_release_total",
  help: "Billing read-path releases of past-expiry checkout locks, by outcome",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

// Processing retry jobs by outcome (queued, succeeded, failed) and failure reason ("none" otherwise).
export const processingRetryJobs = new Counter({
  name: "meeting_processing_retry_jobs_total",
  help: "Meeting processing retry jobs by outcome and failure reason",
  labelNames: ["outcome", "reason"] as const,
  registers: [metricsRegistry],
});

// Express middleware to time requests
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route =
      (req.route && "path" in req.route
        ? (req.route as { path?: string }).path
        : undefined) ||
      req.path ||
      "unknown";
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}
