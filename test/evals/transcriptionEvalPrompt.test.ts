/** @jest-environment node */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readPromptFileContent,
  isTranscriptionLikelyPrompt,
} from "../../src/evals/transcriptionEvalPrompt";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "eval-prompt-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each([
  ["  plain prompt  ", "plain prompt"],
  ["---\ntype: text\n---\n  body prompt  ", "body prompt"],
  [
    "---\ntype: chat\nmessages:\n  - role: user\n    content: ignored user\n  - role: system\n    content: system instruction\n---\nignored body",
    "system instruction",
  ],
  [
    "---\ntype: chat\nprompt:\n  - role: user\n    content: user instruction\n---\n",
    "user instruction",
  ],
  ["---\ntype: chat\nmessages: []\n---\nignored body", ""],
])(
  "reads prompt content without changing format semantics: %s",
  async (source, expected) => {
    const file = path.join(directory, "prompt.md");
    await writeFile(file, source);
    expect(await readPromptFileContent(file)).toBe(expected);
  },
);

test("optional prompt files and read failures retain their behavior", async () => {
  expect(await readPromptFileContent()).toBeUndefined();
  await expect(
    readPromptFileContent(path.join(directory, "missing")),
  ).rejects.toThrow();
});

test("prompt echo similarity still includes the glossary first line", () => {
  expect(
    isTranscriptionLikelyPrompt(
      "dictionary entry",
      "unrelated instructions",
      "dictionary entry\nother vocabulary",
    ),
  ).toBe(true);
  expect(
    isTranscriptionLikelyPrompt(
      "meeting discussion",
      "unrelated instructions",
      "dictionary entry\nother vocabulary",
    ),
  ).toBe(false);
});
