import { z } from "zod";
import {
  withPreparedTranscriptionInput,
  type TranscriptionInputRequest,
} from "../services/transcriptionInputService";
import type {
  SpeechAssessment,
  SpeechAdmission,
} from "../services/speechDetectionTypes";
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  MINIMUM_TRANSCRIPTION_LENGTH,
  RECORD_SAMPLE_RATE,
} from "../constants";
import {
  DEFAULT_NOISE_GATE_CONFIG,
  evaluateNoiseGate,
  isNoiseGateEnabled,
} from "../utils/audioNoiseGate";
import type { Transcription } from "openai/resources/audio";
import {
  guardTranscription,
  resolveTranscriptionGuardConfig,
} from "../services/transcriptionService";
import type { TranscriptionEvalPolicy } from "./transcriptionCorpus";
import type { TranscriptionVadDecision } from "./transcriptionVadReport";
import {
  scoreTranscription,
  type TranscriptionScore,
} from "./transcriptionMetrics";

export type TranscriptionQualityMode = "provider" | "pipeline" | "preflight";
export type RawTranscription = {
  text: string;
  logprobs?: { logprob?: number }[];
  usage?: Transcription["usage"];
};
export type TranscriptionQualityRun = {
  status: "succeeded" | "skipped" | "eligible" | "failed";
  reason?:
    | "minimum_duration"
    | "noise_gate"
    | "vad"
    | "non_speech"
    | "request_error"
    | "budget_exhausted";
  assessment?: SpeechAssessment;
  admission?: SpeechAdmission;
  error?: {
    category: "request_error" | "budget_exhausted";
    status: number | null;
  };
  stages: {
    admissionMs: number;
    conversionMs: number;
    assessmentMs: number | null;
    providerMs: number;
  };
  audioSeconds: number;
  submittedAudioSeconds: number;
  requests: number;
  durationMs: number;
  text?: string;
  raw?: RawTranscription;
  flags: string[];
  score: TranscriptionScore;
  noiseMetrics: ReturnType<typeof evaluateNoiseGate>["metrics"];
  vad?: TranscriptionVadDecision;
};

export class TranscriptionBudgetExhausted extends Error {}

// Input is the same s16le/48kHz/stereo PCM that Discord capture sends to the gates.
export async function runTranscriptionQualityCase(input: {
  pcm: Buffer;
  reference?: string;
  /** Sent to the provider only for comparisons with the former prompted path; production sends none. */
  prompt?: string;
  passMode: "fast" | "slow";
  mode: TranscriptionQualityMode;
  policy: TranscriptionEvalPolicy;
  force: boolean;
  vad?: TranscriptionVadDecision;
  production?: Pick<
    TranscriptionInputRequest,
    "mode" | "pcmFile" | "wavFile" | "policyFingerprint" | "detector"
  >;
  transcribe: (prompt?: string) => Promise<RawTranscription>;
}): Promise<TranscriptionQualityRun> {
  const started = performance.now();
  const audioSeconds =
    input.pcm.length / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  const gateConfig = {
    ...DEFAULT_NOISE_GATE_CONFIG,
    ...input.policy.noiseGate,
  };
  const gate = evaluateNoiseGate(input.pcm, gateConfig);
  const result: TranscriptionQualityRun = {
    status: "eligible",
    stages: {
      admissionMs: 0,
      conversionMs: 0,
      assessmentMs: null,
      providerMs: 0,
    },
    audioSeconds,
    submittedAudioSeconds: 0,
    requests: 0,
    durationMs: 0,
    flags: [],
    score: { scored: false },
    noiseMetrics: gate.metrics,
    vad: input.vad,
  };
  const finish = () => ({ ...result, durationMs: performance.now() - started });
  const reason = skipReason(input, audioSeconds, gateConfig, gate);
  if (reason) {
    Object.assign(result, {
      status: "skipped",
      reason,
      text: "",
      score: scoreTranscription(input.reference, ""),
    });
    return finish();
  }
  const execute = async () => {
    if (input.mode === "preflight") return finish();
    const request = async (prompt?: string) => {
      // The callback enforces the global budget before making an HTTP request.
      // A rejected HTTP request counts too; a budget refusal does not.
      result.requests++;
      result.submittedAudioSeconds += audioSeconds;
      const requestStarted = performance.now();
      try {
        return await input.transcribe(prompt);
      } catch (error) {
        if (error instanceof TranscriptionBudgetExhausted) {
          result.requests--;
          result.submittedAudioSeconds -= audioSeconds;
        }
        throw error;
      } finally {
        result.stages.providerMs += performance.now() - requestStarted;
      }
    };
    try {
      const raw = await request(input.prompt?.trim() || undefined);
      result.raw = raw;
      result.text = raw.text;
      if (input.mode === "pipeline") {
        const guardConfig = resolveTranscriptionGuardConfig(
          input.policy,
          input.force ? false : undefined,
        );
        const guarded = await guardTranscription({
          raw,
          audioSeconds,
          noiseGateMetrics:
            input.pcm.length &&
            ((isNoiseGateEnabled(gateConfig, input.passMode) && !input.force) ||
              guardConfig.suppressionEnabled)
              ? gate.metrics
              : undefined,
          guardConfig,
          traceMetadata: {},
        });
        result.text = guarded.text;
        result.flags = guarded.review.flags;
      }
      result.status = "succeeded";
      result.score = scoreTranscription(input.reference, result.text);
    } catch (error) {
      result.status = "failed";
      result.reason =
        error instanceof TranscriptionBudgetExhausted
          ? "budget_exhausted"
          : "request_error";
      const status = z
        .object({ status: z.number().int().min(100).max(599) })
        .safeParse(error);
      result.error = {
        category: result.reason,
        status: status.success ? status.data.status : null,
      };
      // A failed run is never graded as silence.
    }
    return finish();
  };
  if (
    !input.production ||
    (input.mode === "preflight" && input.production.mode === "off")
  )
    return execute();
  const admissionStarted = performance.now();
  let observed!: () => void;
  const observation = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const output = await withPreparedTranscriptionInput(
    {
      ...input.production,
      pcm: input.pcm,
      phase: input.passMode,
      force: input.force,
      observe: (assessment, durationMs) => {
        result.assessment = assessment;
        result.stages.assessmentMs = durationMs;
        observed();
      },
    },
    async ({ admission, conversionMs }) => {
      result.admission = admission;
      result.stages.admissionMs = performance.now() - admissionStarted;
      result.stages.conversionMs = conversionMs;
      if (
        admission.kind === "assessed" &&
        admission.assessment.kind === "non_speech"
      ) {
        result.status = "skipped";
        result.reason = "non_speech";
        result.text = "";
        result.score = scoreTranscription(input.reference, "");
        return finish();
      }
      return execute();
    },
  );
  // The shared helper has finished cleanup. Shadow-only artifact collection is
  // outside the post-capture processing interval and never delays submission.
  const durationMs = performance.now() - started;
  if (input.production.mode === "shadow" && !input.force) await observation;
  return {
    ...output,
    durationMs,
    assessment: result.assessment,
    stages: result.stages,
  };
}

function skipReason(
  input: Parameters<typeof runTranscriptionQualityCase>[0],
  audioSeconds: number,
  gateConfig: Parameters<typeof evaluateNoiseGate>[1],
  gate: ReturnType<typeof evaluateNoiseGate>,
) {
  if (input.mode === "provider" || input.force) return undefined;
  return audioSeconds <=
    (input.policy.minSnippetSeconds ?? MINIMUM_TRANSCRIPTION_LENGTH)
    ? "minimum_duration"
    : isNoiseGateEnabled(gateConfig, input.passMode) && !gate.shouldTranscribe
      ? "noise_gate"
      : input.vad && !input.vad.shouldTranscribe
        ? "vad"
        : undefined;
}
