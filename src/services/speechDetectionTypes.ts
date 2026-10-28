export type SpeechPhase = "fast" | "slow";

export type SpeechMetrics = {
  peakSpeechProbability: number;
  maxConsecutiveSpeechFrames: number;
  scannedFrames: number;
  totalFrames: number;
  gain: number;
};

export type ScoredSpeechAssessment<K extends string> = {
  kind: K;
  policyFingerprint: string;
  metrics: SpeechMetrics;
};

export type SpeechAssessment =
  | ScoredSpeechAssessment<"speech">
  | ScoredSpeechAssessment<"non_speech">
  | ScoredSpeechAssessment<"uncertain">
  | {
      kind: "unavailable";
      policyFingerprint: string;
      reason:
        | "off"
        | "forced"
        | "not_ready"
        | "queue_full"
        | "timeout"
        | "worker_error"
        | "invalid_input"
        | "invalid_output"
        | "asset_error"
        | "channel_cancellation"
        | "shutdown";
    };

export type SpeechCoverage = {
  pcmSha256: string;
  audioBytes: number;
  policyFingerprint: string;
};

export type SpeechAdmission =
  | { kind: "reused"; coverage: SpeechCoverage }
  | { kind: "not_enforced"; reason: "off" | "forced" | "shadow" }
  | {
      kind: "assessed";
      assessment: SpeechAssessment;
      coverage: SpeechCoverage;
    };

export interface SpeechDetector {
  warm(): Promise<boolean>;
  assess(wav: Uint8Array, phase: SpeechPhase): Promise<SpeechAssessment>;
  shutdown(): Promise<void>;
}

export type SpeechPolicy = {
  sampleRate: 16000;
  frameSamples: 512;
  contextSamples: 64;
  speechThreshold: 0.5;
  rejectionCeiling: 0.35;
  minSpeechFrames: 2;
  targetPeakDbfs: -20;
  maxGain: 100;
  cancellationRmsRatio: 0.1;
  normalizationVersion: "peak-v1";
  impulsePeakRatio: 10;
  negativeGuardVersion: "brief-peak-v1";
  modelSha256: string;
  engineVersion: string;
  policyFingerprint: string;
};

export interface SileroSession {
  infer(
    input: Float32Array,
    state: Float32Array,
  ): Promise<{ probability: number; state: Float32Array }>;
}

export type SpeechUnavailableReason = Extract<
  SpeechAssessment,
  { kind: "unavailable" }
>["reason"];
export type SpeechWorkerRequest = {
  type: "assess";
  requestId: number;
  wav: ArrayBuffer;
  policyFingerprint: string;
};
export type SpeechWorkerReply =
  | { type: "failure"; reason: SpeechUnavailableReason }
  | { type: "ready"; policyFingerprint: string }
  | { type: "assessment"; requestId: number; assessment: SpeechAssessment };
export interface SpeechWorkerTransport {
  post(request: SpeechWorkerRequest): void;
  onReply(listener: (reply: SpeechWorkerReply) => void): () => void;
  onFailure(listener: (reason: SpeechUnavailableReason) => void): () => void;
  terminate(): Promise<void>;
}
export type SpeechDetectorBindings = {
  policy: SpeechPolicy;
  spawn: (policy: SpeechPolicy) => SpeechWorkerTransport;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => { cancel(): void };
};
