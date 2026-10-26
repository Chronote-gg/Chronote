/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import {
  compileSavedPrompt,
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
    compileSavedPrompt(saved, { transcript: "completed generated speech" }),
  ).toEqual([
    { role: "system", content: "Saved instructions" },
    { role: "user", content: "completed generated speech" },
  ]);
  expect(() =>
    savedPromptSchema.parse({ ...saved, client: { apiKey: "forbidden" } }),
  ).toThrow();
});
