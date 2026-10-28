export type TranscriptionScore =
  | { scored: false }
  | {
      scored: true;
      referenceKind: "speech" | "silence";
      exactMatch: boolean;
      unwantedOutput: boolean;
      speechDropped: boolean;
      wer: number | null;
      referenceWords: number;
      wordErrors: number;
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

export function scoreTranscription(
  reference: string | undefined,
  text: string,
): TranscriptionScore {
  if (reference === undefined) return { scored: false };
  const expected = tokenize(reference);
  const actual = tokenize(text);
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
  const silence = reference.trim() === "";
  const wordErrors = previous[actual.length];
  return {
    scored: true,
    referenceKind: silence ? "silence" : "speech",
    exactMatch: silence
      ? text.trim() === ""
      : normalizeTranscriptForCompare(reference) ===
        normalizeTranscriptForCompare(text),
    unwantedOutput: silence && text.trim() !== "",
    speechDropped: !silence && text.trim() === "",
    wer: expected.length > 0 ? wordErrors / expected.length : null,
    referenceWords: expected.length,
    wordErrors,
  };
}

export function summarizeTranscriptionScores(scores: TranscriptionScore[]) {
  const scored = scores.filter((score) => score.scored);
  const silence = scored.filter((score) => score.referenceKind === "silence");
  const speech = scored.filter((score) => score.referenceKind === "speech");
  const referenceWords = scored.reduce(
    (sum, score) => sum + score.referenceWords,
    0,
  );
  const wordErrors = speech.reduce((sum, score) => sum + score.wordErrors, 0);
  return {
    scoredRuns: scored.length,
    unscoredRuns: scores.length - scored.length,
    exactMatchRate: scored.length
      ? scored.filter((score) => score.exactMatch).length / scored.length
      : null,
    silenceRuns: silence.length,
    unwantedOutputRate: silence.length
      ? silence.filter((score) => score.unwantedOutput).length / silence.length
      : null,
    speechRuns: speech.length,
    speechDroppedRate: speech.length
      ? speech.filter((score) => score.speechDropped).length / speech.length
      : null,
    wer: referenceWords ? wordErrors / referenceWords : null,
  };
}
