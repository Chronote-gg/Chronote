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
