export type TranscriptionScore =
  | { scored: false }
  | {
      scored: true;
      referenceKind: "speech" | "silence";
      exactMatch: boolean;
      unwantedOutput: boolean;
      speechDropped: boolean;
      /** Speech reference where the output has fewer than half the reference words. */
      speechMostlyDropped: boolean;
      wer: number | null;
      referenceWords: number;
      wordErrors: number;
      outputWords: number;
      /** Character error rate, only for CJK references where word boundaries are not spoken units. */
      cer: number | null;
      referenceChars: number;
      charErrors: number;
      /** Speech reference written only in Latin script, so wrong-language output is detectable. */
      latinReference: boolean;
      /** Latin reference whose nonempty output contains letters of another script. */
      nonLatinOutput: boolean;
      /** Latin reference whose nonempty output shares no word with it. */
      noSharedWords: boolean;
    };

export const normalizeTranscriptForCompare = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}'\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const tokenize = (value: string) =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: "word" }).segment(
      normalizeTranscriptForCompare(value),
    ),
  )
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const characters = (value: string) =>
  Array.from(normalizeTranscriptForCompare(value).replace(/\s+/g, ""));

function editDistance(expected: string[], actual: string[]) {
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  expected.forEach((word, index) => {
    const current = [index + 1];
    actual.forEach((candidate, column) =>
      current.push(
        Math.min(
          previous[column + 1] + 1,
          current[column] + 1,
          previous[column] + (word === candidate ? 0 : 1),
        ),
      ),
    );
    previous = current;
  });
  return previous[actual.length];
}

function characterScore(reference: string, text: string) {
  const referenceChars = CJK.test(reference) ? characters(reference) : [];
  const charErrors = referenceChars.length
    ? editDistance(referenceChars, characters(text))
    : 0;
  return {
    referenceChars,
    cer: referenceChars.length > 0 ? charErrors / referenceChars.length : null,
    charErrors,
  };
}

// For a Latin-script reference, output in another script or with no shared word is likely the wrong language.
function languageScore(
  reference: string,
  expected: string[],
  actual: string[],
  output: string,
) {
  const latinReference =
    reference.trim() !== "" && !NON_LATIN_LETTER.test(reference);
  const expectedWords = new Set(expected);
  return {
    latinReference,
    nonLatinOutput:
      latinReference && output !== "" && NON_LATIN_LETTER.test(output),
    noSharedWords:
      latinReference &&
      actual.length > 0 &&
      !actual.some((word) => expectedWords.has(word)),
  };
}

function mostlyDropped(
  cjk: boolean,
  text: string,
  referenceChars: string[],
  expected: string[],
  actual: string[],
) {
  return cjk
    ? characters(text).length < referenceChars.length / 2
    : actual.length < expected.length / 2;
}

export function scoreTranscription(
  reference: string | undefined,
  text: string,
): TranscriptionScore {
  if (reference === undefined) return { scored: false };
  const expected = tokenize(reference);
  const actual = tokenize(text);
  const silence = reference.trim() === "";
  const wordErrors = editDistance(expected, actual);
  const output = normalizeTranscriptForCompare(text);
  const chars = characterScore(reference, text);
  return {
    scored: true,
    referenceKind: silence ? "silence" : "speech",
    exactMatch: silence
      ? text.trim() === ""
      : normalizeTranscriptForCompare(reference) === output,
    unwantedOutput: silence && text.trim() !== "",
    speechDropped: !silence && text.trim() === "",
    speechMostlyDropped:
      !silence &&
      mostlyDropped(
        CJK.test(reference),
        text,
        chars.referenceChars,
        expected,
        actual,
      ),
    wer: expected.length > 0 ? wordErrors / expected.length : null,
    referenceWords: expected.length,
    wordErrors,
    outputWords: actual.length,
    cer: chars.cer,
    referenceChars: chars.referenceChars.length,
    charErrors: chars.charErrors,
    ...languageScore(reference, expected, actual, output),
  };
}

export type TermScore = { mentions: number; hits: number; insertions: number };

function countPhrase(words: string[], phrase: string[]) {
  let count = 0;
  for (let index = 0; index + phrase.length <= words.length; index++)
    if (phrase.every((word, offset) => words[index + offset] === word)) count++;
  return count;
}

/** Exact dictionary spellings, case and punctuation ignored. An extra occurrence counts as an insertion. */
export function scoreTerms(
  reference: string | undefined,
  text: string,
  dictionary: readonly string[] = [],
): TermScore {
  const score = { mentions: 0, hits: 0, insertions: 0 };
  if (reference === undefined) return score;
  const expected = tokenize(reference);
  const actual = tokenize(text);
  for (const term of dictionary) {
    const phrase = tokenize(term);
    if (!phrase.length) continue;
    const wanted = countPhrase(expected, phrase);
    const found = countPhrase(actual, phrase);
    score.mentions += wanted;
    score.hits += Math.min(wanted, found);
    score.insertions += Math.max(0, found - wanted);
  }
  return score;
}

export function summarizeTermScores(scores: TermScore[]) {
  const mentions = scores.reduce((sum, score) => sum + score.mentions, 0);
  const hits = scores.reduce((sum, score) => sum + score.hits, 0);
  return {
    termMentions: mentions,
    termHits: hits,
    termRecall: mentions ? hits / mentions : null,
    termInsertions: scores.reduce((sum, score) => sum + score.insertions, 0),
  };
}

const rate = <T>(items: T[], test: (item: T) => boolean) =>
  items.length ? items.filter(test).length / items.length : null;

export function summarizeTranscriptionScores(scores: TranscriptionScore[]) {
  const scored = scores.filter((score) => score.scored);
  const silence = scored.filter((score) => score.referenceKind === "silence");
  const speech = scored.filter((score) => score.referenceKind === "speech");
  // CJK references are graded by characters; word segmentation there is an artifact.
  const wordGraded = speech.filter((score) => score.cer === null);
  const charGraded = speech.filter((score) => score.cer !== null);
  const sum = (
    items: typeof scored,
    pick: (item: (typeof scored)[0]) => number,
  ) => items.reduce((total, item) => total + pick(item), 0);
  const referenceWords = sum(wordGraded, (score) => score.referenceWords);
  const referenceChars = sum(charGraded, (score) => score.referenceChars);
  const latin = speech.filter((score) => score.latinReference);
  return {
    scoredRuns: scored.length,
    unscoredRuns: scores.length - scored.length,
    exactMatchRate: rate(scored, (score) => score.exactMatch),
    silenceRuns: silence.length,
    unwantedOutputRate: rate(silence, (score) => score.unwantedOutput),
    unwantedWordsPerSilenceRun: silence.length
      ? sum(silence, (score) => score.outputWords) / silence.length
      : null,
    speechRuns: speech.length,
    speechDroppedRate: rate(speech, (score) => score.speechDropped),
    speechMostlyDroppedRate: rate(speech, (score) => score.speechMostlyDropped),
    wer: referenceWords
      ? sum(wordGraded, (score) => score.wordErrors) / referenceWords
      : null,
    cer: referenceChars
      ? sum(charGraded, (score) => score.charErrors) / referenceChars
      : null,
    latinReferenceRuns: latin.length,
    nonLatinOutputRuns: latin.filter((score) => score.nonLatinOutput).length,
    nonLatinOutputRate: rate(latin, (score) => score.nonLatinOutput),
    noSharedWordsRuns: latin.filter((score) => score.noSharedWords).length,
    noSharedWordsRate: rate(latin, (score) => score.noSharedWords),
  };
}
