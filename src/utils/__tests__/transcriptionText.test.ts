import {
  getTranscriptionTextQuality,
  isLowInformationTranscriptionText,
  isTrivialTranscriptionText,
} from "../transcriptionText";

describe("transcriptionText", () => {
  it("treats punctuation-only output as trivial", () => {
    const quality = getTranscriptionTextQuality(" . ");

    expect(quality.trivial).toBe(true);
    expect(quality.punctuationOnly).toBe(true);
    expect(quality.reasons).toContain("punctuation_only");
    expect(isTrivialTranscriptionText(".")).toBe(true);
  });

  it("treats ordinary speech as non-trivial", () => {
    const quality = getTranscriptionTextQuality(
      "We should review the transcript tomorrow.",
    );

    expect(quality.trivial).toBe(false);
    expect(quality.alnumCharCount).toBeGreaterThan(0);
    expect(quality.wordCount).toBeGreaterThan(0);
  });

  it("treats non-Latin text as non-trivial", () => {
    const quality = getTranscriptionTextQuality("こんにちは 世界");

    expect(quality.trivial).toBe(false);
    expect(quality.punctuationOnly).toBe(false);
    expect(quality.alnumCharCount).toBeGreaterThan(0);
  });

  it("treats short no-space text as low information but not longer text", () => {
    expect(isLowInformationTranscriptionText("こんにちは世界")).toBe(true);
    expect(
      isLowInformationTranscriptionText("これはかなり長めの日本語テキストです"),
    ).toBe(false);
  });
});
