import { countWords } from "./text";
import { TRANSCRIPTION_FAILURE_PLACEHOLDER } from "../constants";

const LOW_INFORMATION_MAX_WORDS = 8;
const LOW_INFORMATION_MAX_ALNUM_CHARS = 12;

export type TranscriptionTextQuality = {
  trimmed: string;
  charCount: number;
  wordCount: number;
  alnumCharCount: number;
  punctuationOnly: boolean;
  trivial: boolean;
  reasons: string[];
};

const normalizeTranscriptWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

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

export function isLowInformationTranscriptionText(text: string): boolean {
  const quality = getTranscriptionTextQuality(text);
  return (
    !quality.trivial &&
    quality.wordCount > 0 &&
    quality.wordCount <= LOW_INFORMATION_MAX_WORDS &&
    (quality.wordCount > 1 ||
      quality.alnumCharCount <= LOW_INFORMATION_MAX_ALNUM_CHARS)
  );
}

const isContiguousTokenSubarray = (needle: string[], haystack: string[]) => {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }

  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }

  return false;
};

export function areLowInformationTranscriptionTextsNearDuplicates(
  left: string,
  right: string,
): boolean {
  if (
    !isLowInformationTranscriptionText(left) ||
    !isLowInformationTranscriptionText(right)
  ) {
    return false;
  }

  const leftWords = normalizeTranscriptWords(left);
  const rightWords = normalizeTranscriptWords(right);

  if (leftWords.length === 0 || rightWords.length === 0) {
    return false;
  }

  if (leftWords.join(" ") === rightWords.join(" ")) {
    return true;
  }

  // We intentionally treat short phrase containment as a duplicate, so a later
  // expansion like "hello how are you" is dropped when an earlier "hello"
  // from the same speaker already exists in the recent window.
  return (
    isContiguousTokenSubarray(leftWords, rightWords) ||
    isContiguousTokenSubarray(rightWords, leftWords)
  );
}
