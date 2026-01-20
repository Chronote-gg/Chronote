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

describe("applyTranscriptionGuards", () => {
  test("suppresses quiet low-confidence transcriptions", () => {
    const result = applyTranscriptionGuards({
      transcription: "I think we should start with the Vket event.",
      suppressionEnabled: true,
      noiseGateEnabled: true,
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

  test("keeps text when noise gate is disabled", () => {
    const result = applyTranscriptionGuards({
      transcription: "hello there",
      suppressionEnabled: true,
      noiseGateEnabled: false,
      logprobs: [{ logprob: -3 }],
    });

    expect(result.text).toBe("hello there");
    expect(result.flags).toEqual([]);
  });

  test("keeps text when suppression is disabled", () => {
    const result = applyTranscriptionGuards({
      transcription: "quiet but suppression is off",
      suppressionEnabled: false,
      noiseGateEnabled: true,
      noiseGateMetrics: quietMetrics,
      logprobs: [{ logprob: -2.5 }],
    });

    expect(result.text).toBe("quiet but suppression is off");
    expect(result.flags).toEqual([]);
  });
});
