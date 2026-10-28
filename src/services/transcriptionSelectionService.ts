import type { Transcription } from "openai/resources/audio";
import type { MeetingRuntimeConfig } from "../config/types";
import type { NoiseGateMetrics } from "../utils/audioNoiseGate";
import { applyTranscriptionGuards } from "../utils/transcriptionGuards";
import { getTranscriptionTextQuality } from "../utils/transcriptionText";
import { countWords } from "../utils/text";
import {
  decideTranscriptionVote,
  shouldRunTranscriptionVote,
  type TranscriptionVoteCandidate,
  type TranscriptionVoteDecision,
  type TranscriptionVoteGateResult,
} from "../utils/transcriptionVote";
import {
  TRANSCRIPTION_HARD_SILENCE_DBFS,
  TRANSCRIPTION_RATE_MAX_SECONDS,
  TRANSCRIPTION_RATE_MIN_WORDS,
  TRANSCRIPTION_RATE_MIN_SYLLABLES,
  TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND,
} from "../constants";

export type RawTranscriptionCandidate = {
  text: string;
  logprobs?: { logprob?: number }[];
  usage?: Transcription["usage"];
};

export function resolveTranscriptionGuardConfig(
  settings?: Partial<
    Pick<
      MeetingRuntimeConfig["transcription"],
      | "suppressionEnabled"
      | "promptEchoEnabled"
      | "suppressionHardSilenceDbfs"
      | "suppressionRateMaxSeconds"
      | "suppressionRateMinWords"
      | "suppressionRateMinSyllables"
      | "suppressionRateMaxSyllablesPerSecond"
    >
  >,
  suppressionOverride?: boolean,
) {
  return {
    suppressionEnabled:
      suppressionOverride ?? settings?.suppressionEnabled ?? true,
    promptEchoEnabled: settings?.promptEchoEnabled ?? true,
    hardSilenceDbfs:
      settings?.suppressionHardSilenceDbfs ?? TRANSCRIPTION_HARD_SILENCE_DBFS,
    ...resolveRateConfig(settings),
  };
}

function resolveRateConfig(
  settings: Parameters<typeof resolveTranscriptionGuardConfig>[0],
) {
  return {
    rateMaxSeconds:
      settings?.suppressionRateMaxSeconds ?? TRANSCRIPTION_RATE_MAX_SECONDS,
    rateMinWords:
      settings?.suppressionRateMinWords ?? TRANSCRIPTION_RATE_MIN_WORDS,
    rateMinSyllables:
      settings?.suppressionRateMinSyllables ?? TRANSCRIPTION_RATE_MIN_SYLLABLES,
    maxSyllablesPerSecond:
      settings?.suppressionRateMaxSyllablesPerSecond ??
      TRANSCRIPTION_RATE_MAX_SYLLABLES_PER_SECOND,
  };
}

export type TranscriptionGuardConfig = ReturnType<
  typeof resolveTranscriptionGuardConfig
>;
export type TranscriptStats = {
  transcriptCharCount: number;
  transcriptWordCount: number;
  transcriptSyllableCount?: number;
  wordsPerSecond?: number;
  syllablesPerSecond?: number;
};
export type GuardedTranscriptionCandidate = TranscriptionGuardConfig & {
  candidateId: "prompt" | "no_prompt";
  rawTextQuality: ReturnType<typeof getTranscriptionTextQuality>;
  selectedTextQuality: ReturnType<typeof getTranscriptionTextQuality>;
  guardResult: ReturnType<typeof applyTranscriptionGuards>;
  transcriptStats: TranscriptStats;
  usage?: Transcription["usage"];
};
export type TranscriptionSelection = {
  selected: Omit<GuardedTranscriptionCandidate, "candidateId"> & {
    candidateId: "prompt" | "no_prompt" | "none";
  };
  promptCandidate: GuardedTranscriptionCandidate;
  noPromptCandidate?: GuardedTranscriptionCandidate;
  voteGate: TranscriptionVoteGateResult;
  voteDecision?: TranscriptionVoteDecision;
};

export async function selectTranscription(input: {
  transcribe: (prompt?: string) => Promise<RawTranscriptionCandidate>;
  prompt?: string;
  passMode: "fast" | "slow";
  voteEnabled: boolean;
  guardConfig: TranscriptionGuardConfig;
  audioSeconds?: number;
  noiseGateMetrics?: NoiseGateMetrics;
  onCandidate?: (candidate: GuardedTranscriptionCandidate) => void;
  onSyllableError?: (error: unknown) => void;
}): Promise<TranscriptionSelection> {
  const evaluate = async (
    id: GuardedTranscriptionCandidate["candidateId"],
    raw: RawTranscriptionCandidate,
    promptText?: string,
  ): Promise<GuardedTranscriptionCandidate> => {
    const rawTextQuality = getTranscriptionTextQuality(raw.text);
    let transcriptSyllableCount: number | undefined = 0;
    if (raw.text.trim()) {
      try {
        transcriptSyllableCount = (await import("syllable")).syllable(
          raw.text.trim(),
        );
      } catch (error) {
        transcriptSyllableCount = undefined;
        input.onSyllableError?.(error);
      }
    }
    const words = countWords(raw.text.trim());
    const transcriptStats: TranscriptStats = {
      transcriptCharCount: raw.text.trim().length,
      transcriptWordCount: words,
      transcriptSyllableCount,
      wordsPerSecond:
        input.audioSeconds && input.audioSeconds > 0
          ? words / input.audioSeconds
          : undefined,
      syllablesPerSecond:
        input.audioSeconds &&
        input.audioSeconds > 0 &&
        transcriptSyllableCount !== undefined
          ? transcriptSyllableCount / input.audioSeconds
          : undefined,
    };
    const promptEchoEnabled =
      input.guardConfig.promptEchoEnabled && Boolean(promptText);
    const guardResult = applyTranscriptionGuards({
      ...input.guardConfig,
      transcription: raw.text,
      promptEchoEnabled,
      promptText,
      noiseGateMetrics: input.noiseGateMetrics,
      audioSeconds: input.audioSeconds,
      transcriptWordCount: words,
      transcriptSyllableCount,
      logprobs: raw.logprobs,
    });
    const result: GuardedTranscriptionCandidate = {
      ...input.guardConfig,
      promptEchoEnabled,
      candidateId: id,
      rawTextQuality,
      selectedTextQuality: getTranscriptionTextQuality(guardResult.text),
      guardResult,
      transcriptStats,
      usage: raw.usage,
    };
    input.onCandidate?.(result);
    return result;
  };

  const promptCandidate = await evaluate(
    "prompt",
    await input.transcribe(input.prompt),
    input.prompt,
  );
  const voteGate = shouldRunTranscriptionVote({
    enabled: input.voteEnabled,
    hasPrompt: Boolean(input.prompt),
    passMode: input.passMode,
    primaryCandidate: buildTranscriptionVoteCandidate(promptCandidate),
  });
  if (!voteGate.shouldRun)
    return { selected: promptCandidate, promptCandidate, voteGate };
  const noPromptCandidate = await evaluate(
    "no_prompt",
    await input.transcribe(),
  );
  const voteDecision = decideTranscriptionVote({
    promptCandidate: buildTranscriptionVoteCandidate(promptCandidate),
    noPromptCandidate: buildTranscriptionVoteCandidate(noPromptCandidate),
  });
  const selected =
    voteDecision.selectedId === "no_prompt"
      ? noPromptCandidate
      : voteDecision.selectedId === "none"
        ? {
            ...promptCandidate,
            candidateId: "none" as const,
            selectedTextQuality: getTranscriptionTextQuality(""),
            guardResult: {
              ...promptCandidate.guardResult,
              text: "",
              suppressed: true,
              flags: [
                ...promptCandidate.guardResult.flags,
                "suppressed_vote_quality_floor",
              ],
            },
          }
        : promptCandidate;
  return {
    selected,
    promptCandidate,
    noPromptCandidate,
    voteGate,
    voteDecision,
  };
}

export const buildTranscriptionVoteCandidate = (
  candidate: Pick<GuardedTranscriptionCandidate, "candidateId" | "guardResult">,
): TranscriptionVoteCandidate => ({
  id: candidate.candidateId,
  text: candidate.guardResult.text,
  suppressed: candidate.guardResult.suppressed,
  promptEchoDetected: candidate.guardResult.promptEchoDetected,
  rateMismatchDetected: candidate.guardResult.rateMismatchDetected,
  quietAudio: candidate.guardResult.quietAudio,
  logprobMetrics: candidate.guardResult.logprobMetrics,
});
