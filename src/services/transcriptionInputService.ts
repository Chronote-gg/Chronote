import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { SpeechDetectionMode } from "../config/speechDetection";
import { convertTranscriptionPcmToWav } from "./transcriptionAudioService";
import { createSpeechCoverage } from "./speechDetectionPolicy";
import type {
  SpeechAdmission,
  SpeechAssessment,
  SpeechCoverage,
  SpeechDetector,
  SpeechPhase,
} from "./speechDetectionTypes";

export type TranscriptionInputRequest = {
  pcm: Buffer;
  pcmFile: string;
  wavFile: string;
  mode: SpeechDetectionMode;
  phase: SpeechPhase;
  force: boolean;
  policyFingerprint: string;
  detector?: SpeechDetector;
  signal?: AbortSignal;
  observe: (assessment: SpeechAssessment, durationMs: number) => void;
};
export type PreparedTranscriptionInput = {
  wavFile: string;
  conversionMs: number;
  coverage: SpeechCoverage;
  admission: SpeechAdmission;
};

const cleanup = (file: string): void => {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    console.warn(
      "Failed cleaning up temporary transcription input, continuing.",
    );
  }
};

async function assessInput(
  request: TranscriptionInputRequest,
): Promise<SpeechAssessment> {
  const startedAt = performance.now();
  let assessment: SpeechAssessment;
  try {
    // Own the bytes before scheduling worker work. Shadow may outlive both files.
    const wav = new Uint8Array(readFileSync(request.wavFile));
    assessment = request.detector
      ? await request.detector.assess(wav, request.phase)
      : {
          kind: "unavailable",
          reason: "not_ready",
          policyFingerprint: request.policyFingerprint,
        };
  } catch {
    assessment = {
      kind: "unavailable",
      reason: "worker_error",
      policyFingerprint: request.policyFingerprint,
    };
  }
  try {
    request.observe(assessment, performance.now() - startedAt);
  } catch {
    // Observability must never change admission or the provider result.
  }
  return assessment;
}

export async function withPreparedTranscriptionInput<T>(
  request: TranscriptionInputRequest,
  consume: (prepared: PreparedTranscriptionInput) => Promise<T>,
): Promise<T> {
  try {
    request.signal?.throwIfAborted();
    const coverage = createSpeechCoverage(
      request.pcm,
      request.policyFingerprint,
    );
    writeFileSync(request.pcmFile, request.pcm);
    const conversionStarted = performance.now();
    await convertTranscriptionPcmToWav(
      request.pcmFile,
      request.wavFile,
      request.signal,
    );
    request.signal?.throwIfAborted();
    const conversionMs = performance.now() - conversionStarted;
    let admission: SpeechAdmission;
    if (request.force) {
      admission = { kind: "not_enforced", reason: "forced" };
    } else if (request.mode === "off") {
      admission = { kind: "not_enforced", reason: "off" };
    } else if (request.mode === "shadow") {
      void assessInput(request);
      admission = { kind: "not_enforced", reason: "shadow" };
    } else {
      admission = {
        kind: "assessed",
        assessment: await assessInput(request),
        coverage,
      };
    }
    return await consume({
      wavFile: request.wavFile,
      conversionMs,
      coverage,
      admission,
    });
  } finally {
    cleanup(request.pcmFile);
    cleanup(request.wavFile);
  }
}
