import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  referenceForCase,
  transcriptionCorpusSchema,
} from "../../src/evals/transcriptionCorpus";
const base = {
  id: "clip",
  file: "clip.wav",
  sha256: "a".repeat(64),
  split: "holdout",
};
test("silence is an explicit reference while unreviewed clips are unscored", () => {
  const corpus = transcriptionCorpusSchema.parse({
    version: 1,
    name: "test",
    cases: [
      { ...base, label: { kind: "nonspeech", provenance: "human-reviewed" } },
      { ...base, id: "unknown", label: { kind: "unreviewed" } },
    ],
  });
  expect(referenceForCase(corpus.cases[0])).toBe("");
  expect(referenceForCase(corpus.cases[1])).toBeUndefined();
});
test("requires provenance and content hashes and rejects duplicate case IDs", () => {
  const valid = {
    ...base,
    label: { kind: "speech", transcript: "yes", provenance: "synthetic" },
  };
  for (const cases of [
    [{ ...valid, sha256: undefined }],
    [{ ...valid, label: { kind: "speech", transcript: "" } }],
    [valid, valid],
  ]) {
    expect(
      transcriptionCorpusSchema.safeParse({ version: 1, name: "test", cases })
        .success,
    ).toBe(false);
  }
});
test("the public corpus manifest parses and pins every audio file", () => {
  const dir = path.resolve(__dirname, "../fixtures/transcription-public");
  const corpus = transcriptionCorpusSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")),
  );
  for (const item of corpus.cases)
    expect([
      item.id,
      createHash("sha256")
        .update(readFileSync(path.join(dir, item.file)))
        .digest("hex"),
    ]).toEqual([item.id, item.sha256]);
});
