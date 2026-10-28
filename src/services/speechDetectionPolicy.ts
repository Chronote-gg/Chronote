import { createHash } from "node:crypto";
import type { SpeechCoverage, SpeechPolicy } from "./speechDetectionTypes";

const parameters = {
  sampleRate: 16000,
  frameSamples: 512,
  contextSamples: 64,
  speechThreshold: 0.5,
  rejectionCeiling: 0.35,
  minSpeechFrames: 2,
  targetPeakDbfs: -20,
  maxGain: 100,
  cancellationRmsRatio: 0.1,
  normalizationVersion: "peak-v1",
  impulsePeakRatio: 10,
  negativeGuardVersion: "brief-peak-v1",
  modelSha256:
    "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
  engineVersion: "onnxruntime-node@1.30.0",
} satisfies Omit<SpeechPolicy, "policyFingerprint">;

export const DEFAULT_SPEECH_POLICY: SpeechPolicy = Object.freeze({
  ...parameters,
  policyFingerprint: createHash("sha256")
    .update(JSON.stringify(parameters))
    .digest("hex"),
});

export const createSpeechCoverage = (
  pcm: Buffer,
  policyFingerprint: string,
): SpeechCoverage => ({
  pcmSha256: createHash("sha256").update(pcm).digest("hex"),
  audioBytes: pcm.length,
  policyFingerprint,
});

export const speechCoverageMatches = (
  pcm: Buffer,
  coverage: SpeechCoverage,
  policyFingerprint: string,
): boolean =>
  coverage.policyFingerprint === policyFingerprint &&
  coverage.audioBytes === pcm.length &&
  coverage.pcmSha256 === createSpeechCoverage(pcm, policyFingerprint).pcmSha256;
