import type { ClientOptions } from "openai";
import type { Transcription } from "openai/resources/audio";

export type TranscriptionCandidateId = "prompt" | "no_prompt";
export type TranscriptionAttemptOutcome =
  | { kind: "success" }
  | { kind: "failure"; failure: "http"; status: number }
  | {
      kind: "failure";
      failure: "input" | "cancelled" | "connection" | "timeout" | "other";
    };

type Usage = Transcription["usage"];
type ReturnedUsage = { kind: "missing" } | { kind: "returned"; usage: Usage };
type Attempt = {
  candidate: TranscriptionCandidateId;
  invocations: number;
  dispatches: number;
  returned: ReturnedUsage;
  outcome?: TranscriptionAttemptOutcome;
};

export type TranscriptionAttemptSnapshot = {
  logicalCandidateCount: number;
  sdkInvocationCount: number;
  httpDispatchAttemptCount: number;
  retryCount: number;
  knownUsageAttemptCount: number;
  unknownUsageAttemptCount: number;
  attemptUsageCoverage: "not_attempted" | "complete" | "partial" | "unknown";
  estimatedAttemptAudioSeconds?: number;
  returnedUsages: Usage[];
};

const validNumber = (value: number) => Number.isFinite(value) && value >= 0;

export function hasPricedTranscriptionUsage(
  usage: Usage,
): usage is Extract<NonNullable<Usage>, { type: "tokens" }> {
  return (
    usage?.type === "tokens" &&
    validNumber(usage.input_tokens) &&
    validNumber(usage.output_tokens)
  );
}

function hasKnownUsage(usage: Usage) {
  if (hasPricedTranscriptionUsage(usage)) {
    return validNumber(usage.total_tokens);
  }
  return usage?.type === "duration" && validNumber(usage.seconds);
}

function usageCoverage(known: number, dispatched: number) {
  if (dispatched === 0) return "not_attempted";
  if (known === dispatched) return "complete";
  return known > 0 ? "partial" : "unknown";
}

function estimatedAudioSeconds(
  audioSeconds: number | undefined,
  count: number,
) {
  if (audioSeconds === undefined || !validNumber(audioSeconds) || count === 0) {
    return undefined;
  }
  const seconds = audioSeconds * count;
  return validNumber(seconds) ? Number(seconds.toFixed(3)) : undefined;
}

function snapshotAttempts(
  candidates: Set<TranscriptionCandidateId>,
  attempts: Attempt[],
  audioSeconds?: number,
): TranscriptionAttemptSnapshot {
  let sdkInvocationCount = 0;
  let httpDispatchAttemptCount = 0;
  let knownUsageAttemptCount = 0;
  const invocations = { prompt: 0, no_prompt: 0 };
  const returnedUsages: Usage[] = [];
  for (const attempt of attempts) {
    sdkInvocationCount += attempt.invocations;
    invocations[attempt.candidate] += attempt.invocations;
    httpDispatchAttemptCount += attempt.dispatches;
    if (attempt.returned.kind === "returned") {
      returnedUsages.push(attempt.returned.usage);
      if (attempt.dispatches > 0 && hasKnownUsage(attempt.returned.usage)) {
        knownUsageAttemptCount += 1;
      }
    }
  }
  return {
    logicalCandidateCount: candidates.size,
    sdkInvocationCount,
    httpDispatchAttemptCount,
    retryCount: Object.values(invocations).reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ),
    knownUsageAttemptCount,
    unknownUsageAttemptCount: httpDispatchAttemptCount - knownUsageAttemptCount,
    attemptUsageCoverage: usageCoverage(
      knownUsageAttemptCount,
      httpDispatchAttemptCount,
    ),
    estimatedAttemptAudioSeconds: estimatedAudioSeconds(
      audioSeconds,
      httpDispatchAttemptCount,
    ),
    returnedUsages,
  };
}

function attemptRecord(attempt: Attempt) {
  return {
    markSdkInvocation() {
      attempt.invocations += 1;
    },
    wrapFetch(delegate: NonNullable<ClientOptions["fetch"]>) {
      const fetch: NonNullable<ClientOptions["fetch"]> = (url, init) => {
        attempt.dispatches += 1;
        return delegate(url, init);
      };
      return fetch;
    },
    recordReturnedUsage(usage: Usage) {
      attempt.returned = { kind: "returned", usage };
    },
    settle(outcome: TranscriptionAttemptOutcome) {
      attempt.outcome = outcome;
    },
  };
}

export function createTranscriptionAttemptLedger(audioSeconds?: number) {
  const candidates = new Set<TranscriptionCandidateId>();
  const attempts: Attempt[] = [];
  return {
    beginCandidate(candidate: TranscriptionCandidateId) {
      candidates.add(candidate);
    },
    beginAttempt(candidate: TranscriptionCandidateId) {
      const attempt: Attempt = {
        candidate,
        invocations: 0,
        dispatches: 0,
        returned: { kind: "missing" },
      };
      attempts.push(attempt);
      return attemptRecord(attempt);
    },
    snapshot() {
      return snapshotAttempts(candidates, attempts, audioSeconds);
    },
  };
}

export function transcriptionAttemptMetadata(
  snapshot: TranscriptionAttemptSnapshot,
) {
  return {
    transcriptionLogicalCandidateCount: snapshot.logicalCandidateCount,
    transcriptionSdkInvocationCount: snapshot.sdkInvocationCount,
    transcriptionHttpDispatchAttemptCount: snapshot.httpDispatchAttemptCount,
    transcriptionRetryCount: snapshot.retryCount,
    transcriptionKnownUsageAttemptCount: snapshot.knownUsageAttemptCount,
    transcriptionUnknownUsageAttemptCount: snapshot.unknownUsageAttemptCount,
    transcriptionAttemptUsageCoverage: snapshot.attemptUsageCoverage,
    ...(snapshot.estimatedAttemptAudioSeconds === undefined
      ? {}
      : {
          transcriptionEstimatedAttemptAudioSeconds:
            snapshot.estimatedAttemptAudioSeconds,
        }),
  };
}
