import {
  boundDictionaryTeachingNotesDiff,
  selectDictionaryTeachingTranscriptExcerpt,
} from "../../src/services/dictionaryTeachingContextService";

describe("dictionaryTeachingContextService", () => {
  test("selects bounded transcript lines related to a correction", () => {
    const excerpt = selectDictionaryTeachingTranscriptExcerpt({
      transcript: [
        "Alice: The unrelated launch is next week.",
        "Bob: Jon Smythe from Apollo owns the rollout.",
        "Alice: We should send Jon the final deck.",
      ].join("\n"),
      instruction: "John Smith should be Jon Smythe, our Apollo contact.",
      notesDiff: "- John Smith owns the rollout\n+ Jon Smythe owns the rollout",
      maxChars: 80,
    });

    expect(excerpt).toContain("Jon Smythe");
    expect(excerpt.length).toBeLessThanOrEqual(80);
    expect(excerpt).not.toContain("unrelated launch");
  });

  test("does not include transcript text when there are no useful query terms", () => {
    expect(
      selectDictionaryTeachingTranscriptExcerpt({
        transcript: "Alice discussed Apollo.",
        instruction: "this should be correct",
        notesDiff: "",
      }),
    ).toBe("");
  });

  test("matches short correction terms on token boundaries", () => {
    const excerpt = selectDictionaryTeachingTranscriptExcerpt({
      transcript: [
        "Alice: Planning starts after lunch.",
        "Bob: An artifact owns the launch checklist.",
        "Alice: Ann owns the final review.",
      ].join("\n"),
      instruction: "Ann",
      notesDiff: "+ Ann",
    });

    expect(excerpt).toContain("Ann owns the final review");
    expect(excerpt).not.toContain("Planning");
    expect(excerpt).not.toContain("artifact");
  });

  test("bounds notes correction context", () => {
    const result = boundDictionaryTeachingNotesDiff("x".repeat(200), 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain("truncated");
  });
});
