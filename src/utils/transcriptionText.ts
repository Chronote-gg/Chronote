import { countWords } from "./text";
import { TRANSCRIPTION_FAILURE_PLACEHOLDER } from "../constants";

export type TranscriptionTextQuality = {
  trimmed: string;
  charCount: number;
  wordCount: number;
  alnumCharCount: number;
  punctuationOnly: boolean;
  trivial: boolean;
  reasons: string[];
};

const countAlnumChars = (text: string) =>
  Array.from(text).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;

export function getTranscriptionTextQuality(
  text: string,
): TranscriptionTextQuality {
  const trimmed = text.trim();
  const wordCount = countWords(trimmed);
  const alnumCharCount = countAlnumChars(trimmed);
  const punctuationOnly = trimmed.length > 0 && alnumCharCount === 0;
  const reasons: string[] = [];

  if (!trimmed) {
    reasons.push("empty_text");
  }
  if (trimmed === TRANSCRIPTION_FAILURE_PLACEHOLDER) {
    reasons.push("failure_placeholder");
  }
  if (punctuationOnly) {
    reasons.push("punctuation_only");
  }

  return {
    trimmed,
    charCount: trimmed.length,
    wordCount,
    alnumCharCount,
    punctuationOnly,
    trivial: reasons.length > 0,
    reasons,
  };
}

export function isTrivialTranscriptionText(text: string): boolean {
  return getTranscriptionTextQuality(text).trivial;
}
