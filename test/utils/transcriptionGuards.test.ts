import type { NoiseGateMetrics } from "../../src/utils/audioNoiseGate";
import { applyTranscriptionGuards } from "../../src/utils/transcriptionGuards";

const quietMetrics: NoiseGateMetrics = {
  windowMs: 20,
  totalWindows: 8,
  peakDbfs: -50,
  noiseFloorDbfs: -60,
  activeWindowCount: 1,
  minActiveWindows: 2,
  minPeakAboveNoiseDb: 15,
  thresholdDbfs: -45,
};

const hardSilenceMetrics: NoiseGateMetrics = {
  windowMs: 20,
  totalWindows: 8,
  peakDbfs: -70,
  noiseFloorDbfs: -80,
  activeWindowCount: 1,
  minActiveWindows: 2,
  minPeakAboveNoiseDb: 15,
  thresholdDbfs: -45,
};

describe("applyTranscriptionGuards", () => {
  test("suppresses quiet low-confidence transcriptions", () => {
    const result = applyTranscriptionGuards({
      transcription: "I think we should start with the Vket event.",
      suppressionEnabled: true,
      promptEchoEnabled: false,
      noiseGateMetrics: quietMetrics,
      logprobs: [{ logprob: -1.4 }, { logprob: -2.6 }],
    });

    expect(result.text).toBe("");
    expect(result.flags).toEqual(
      expect.arrayContaining([
        "quiet_audio",
        "low_confidence",
        "suppressed_low_confidence",
      ]),
    );
  });

  test("keeps text when loudness metrics are missing", () => {
    const result = applyTranscriptionGuards({
      transcription: "hello there",
      suppressionEnabled: true,
      promptEchoEnabled: false,
      logprobs: [{ logprob: -3 }],
    });

    expect(result.text).toBe("hello there");
    expect(result.flags).toEqual([]);
  });

  test("keeps text when suppression is disabled", () => {
    const result = applyTranscriptionGuards({
      transcription: "quiet but suppression is off",
      suppressionEnabled: false,
      promptEchoEnabled: false,
      noiseGateMetrics: quietMetrics,
      logprobs: [{ logprob: -2.5 }],
    });

    expect(result.text).toBe("quiet but suppression is off");
    expect(result.flags).toEqual([]);
  });

  test("suppresses quiet audio when min logprob is low", () => {
    const result = applyTranscriptionGuards({
      transcription: "We should coordinate on the Vket schedule.",
      suppressionEnabled: true,
      promptEchoEnabled: false,
      noiseGateMetrics: quietMetrics,
      logprobs: [{ logprob: -0.1 }, { logprob: -2.6 }, { logprob: -0.2 }],
    });

    expect(result.text).toBe("");
    expect(result.flags).toEqual(
      expect.arrayContaining([
        "quiet_audio",
        "low_confidence",
        "suppressed_low_confidence",
      ]),
    );
  });

  test("suppresses hard silence even with confident logprobs", () => {
    const result = applyTranscriptionGuards({
      transcription: "hello there",
      suppressionEnabled: true,
      hardSilenceDbfs: -60,
      promptEchoEnabled: false,
      noiseGateMetrics: hardSilenceMetrics,
      logprobs: [{ logprob: -0.2 }, { logprob: -0.3 }],
    });

    expect(result.text).toBe("");
    expect(result.flags).toEqual(
      expect.arrayContaining(["hard_silence", "suppressed_hard_silence"]),
    );
  });

  test("suppresses rate mismatch for short high-rate snippets", () => {
    const result = applyTranscriptionGuards({
      transcription:
        "I think we should have a meeting to discuss the Vket event.",
      suppressionEnabled: true,
      promptEchoEnabled: false,
      audioSeconds: 0.5,
      transcriptWordCount: 13,
      transcriptSyllableCount: 18,
      rateMaxSeconds: 3,
      rateMinWords: 4,
      rateMinSyllables: 8,
      maxSyllablesPerSecond: 7,
    });

    expect(result.text).toBe("");
    expect(result.flags).toEqual(
      expect.arrayContaining(["rate_mismatch", "suppressed_rate_mismatch"]),
    );
  });

  test("keeps short acknowledgements below rate minimums", () => {
    const result = applyTranscriptionGuards({
      transcription: "Yeah, ok.",
      suppressionEnabled: true,
      promptEchoEnabled: false,
      audioSeconds: 0.8,
      transcriptWordCount: 2,
      transcriptSyllableCount: 2,
      rateMaxSeconds: 3,
      rateMinWords: 4,
      rateMinSyllables: 8,
      maxSyllablesPerSecond: 7,
    });

    expect(result.text).toBe("Yeah, ok.");
    expect(result.flags).toEqual([]);
  });

  test("suppresses prompt echo when enabled", () => {
    const result = applyTranscriptionGuards({
      transcription: "Server Name: BASIC's Creations",
      suppressionEnabled: false,
      promptEchoEnabled: true,
      promptText:
        "Server Name: BASIC's Creations Channel: staff-chat Attendees: BASIC",
    });

    expect(result.text).toBe("");
    expect(result.flags).toEqual(
      expect.arrayContaining([
        "prompt_echo_substring",
        "suppressed_prompt_echo",
      ]),
    );
  });

  test("keeps text when prompt echo gate is disabled", () => {
    const result = applyTranscriptionGuards({
      transcription: "Server Name: BASIC's Creations",
      suppressionEnabled: false,
      promptEchoEnabled: false,
      promptText:
        "Server Name: BASIC's Creations Channel: staff-chat Attendees: BASIC",
    });

    expect(result.text).toBe("Server Name: BASIC's Creations");
    expect(result.flags).toEqual([]);
  });
});
