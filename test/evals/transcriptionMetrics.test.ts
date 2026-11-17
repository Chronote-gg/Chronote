import {
  scoreTranscription,
  summarizeTranscriptionScores,
} from "../../src/evals/transcriptionMetrics";

test("scores an explicit silence reference and counts punctuation as unwanted output", () => {
  expect(scoreTranscription("", "")).toMatchObject({
    scored: true,
    exactMatch: true,
    unwantedOutput: false,
  });
  expect(scoreTranscription("", "###")).toMatchObject({
    scored: true,
    exactMatch: false,
    unwantedOutput: true,
  });
  expect(scoreTranscription(undefined, "guess")).toEqual({ scored: false });
});

test("preserves non-Latin text when grading a reference", () => {
  expect(scoreTranscription("こんにちは", "こんにちは")).toMatchObject({
    scored: true,
    exactMatch: true,
    wer: 0,
  });
  expect(scoreTranscription("こんにちは", "Hello")).toMatchObject({
    scored: true,
    exactMatch: false,
  });
});

test("preserves combining marks when distinguishing Hindi vowel forms", () => {
  expect(scoreTranscription("दिन", "दुन")).toMatchObject({
    scored: true,
    exactMatch: false,
    referenceWords: 1,
    wordErrors: 1,
    wer: 1,
  });
  expect(scoreTranscription("दिन", "दिन")).toMatchObject({
    scored: true,
    exactMatch: true,
    referenceWords: 1,
    wordErrors: 0,
    wer: 0,
  });
});
test("reports every run rather than grading only the modal output", () => {
  const summary = summarizeTranscriptionScores([
    scoreTranscription("", ""),
    scoreTranscription("", ""),
    scoreTranscription("", "Hello"),
  ]);
  expect(summary.scoredRuns).toBe(3);
  expect(summary.unwantedOutputRate).toBeCloseTo(1 / 3);
});

test("counts substitutions, insertions, and deletions and weights by reference words", () => {
  expect(scoreTranscription("meet on Friday", "meet on Monday")).toMatchObject({
    wordErrors: 1,
    wer: 1 / 3,
  });
  expect(scoreTranscription("Yes", "Yes please")).toMatchObject({
    wordErrors: 1,
    wer: 1,
  });
  expect(scoreTranscription("meet on Friday", "meet Friday")).toMatchObject({
    wordErrors: 1,
    wer: 1 / 3,
  });
  const summary = summarizeTranscriptionScores([
    scoreTranscription("yes", ""),
    scoreTranscription("meet on Friday", "meet on Monday"),
    scoreTranscription(undefined, "ignored"),
  ]);
  expect(summary.wer).toBe(0.5);
  expect(summary.speechDroppedRate).toBe(0.5);
  expect(summary.unscoredRuns).toBe(1);
});

test("grades CJK references by characters and keeps them out of WER", () => {
  const score = scoreTranscription("こんにちは世界", "こんにちわ世界");
  expect(score).toMatchObject({ cer: 1 / 7, charErrors: 1 });
  const summary = summarizeTranscriptionScores([
    score,
    scoreTranscription("meet on Friday", "meet on Monday"),
  ]);
  expect(summary.cer).toBeCloseTo(1 / 7);
  expect(summary.wer).toBeCloseTo(1 / 3);
});

test("flags partial drops and words emitted on nonspeech", () => {
  expect(scoreTranscription("", "Lantern Hollow.")).toMatchObject({
    unwantedOutput: true,
    outputWords: 2,
  });
  expect(
    scoreTranscription("one two three four five", "one two"),
  ).toMatchObject({ speechMostlyDropped: true, speechDropped: false });
  const summary = summarizeTranscriptionScores([
    scoreTranscription("", "Lantern Hollow."),
    scoreTranscription("", ""),
  ]);
  expect(summary.unwantedWordsPerSilenceRun).toBe(1);
});

test("flags wrong-language output on a Latin-script reference", () => {
  expect(scoreTranscription("Where is that", "Where is that?")).toMatchObject({
    latinReference: true,
    nonLatinOutput: false,
    noSharedWords: false,
  });
  expect(scoreTranscription("Where is that", "Где это")).toMatchObject({
    latinReference: true,
    nonLatinOutput: true,
    noSharedWords: true,
  });
  expect(scoreTranscription("Where is that", "Dónde está")).toMatchObject({
    nonLatinOutput: false,
    noSharedWords: true,
  });
  expect(scoreTranscription("Where is that", "")).toMatchObject({
    nonLatinOutput: false,
    noSharedWords: false,
  });
  expect(scoreTranscription("こんにちは", "Hello")).toMatchObject({
    latinReference: false,
    nonLatinOutput: false,
    noSharedWords: false,
  });
  const summary = summarizeTranscriptionScores([
    scoreTranscription("Where is that", "Где это"),
    scoreTranscription("Where is that", "Dónde está"),
    scoreTranscription("Where is that", "where is that"),
    scoreTranscription("", ""),
  ]);
  expect(summary).toMatchObject({
    latinReferenceRuns: 3,
    nonLatinOutputRuns: 1,
    noSharedWordsRuns: 2,
  });
  expect(summary.nonLatinOutputRate).toBeCloseTo(1 / 3);
  expect(summary.noSharedWordsRate).toBeCloseTo(2 / 3);
});
