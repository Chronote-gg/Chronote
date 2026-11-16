/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import {
  compileSavedChatPrompt,
  savedPromptSchema,
} from "../../src/services/savedRecordingPrompt";

test("frozen SDK template compiles new transcript without looking up a changed label", () => {
  const saved = savedPromptSchema.parse({
    type: "chat",
    name: "notes",
    label: "production",
    version: 7,
    template: [
      { role: "system", content: "Saved instructions" },
      { role: "user", content: "{{transcript}}" },
    ],
  });
  expect(
    compileSavedChatPrompt(saved, { transcript: "completed generated speech" })
      .messages,
  ).toEqual([
    { role: "system", content: "Saved instructions" },
    { role: "user", content: "completed generated speech" },
  ]);
  expect(() =>
    savedPromptSchema.parse({ ...saved, client: { apiKey: "forbidden" } }),
  ).toThrow();
});

test("a text prompt saved by the former transcription path still parses", () => {
  expect(
    savedPromptSchema.parse({
      type: "text",
      name: "chronote-transcription-prompt",
      label: "production",
      version: 1,
      template: "<glossary>{{serverName}}</glossary>",
    }),
  ).toMatchObject({ type: "text" });
});
