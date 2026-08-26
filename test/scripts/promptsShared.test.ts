import path from "node:path";
import { readPromptFileResolved } from "../../scripts/prompts/shared";

describe("prompt file parsing", () => {
  test("reads chat prompt front matter with the supported YAML parser", async () => {
    const prompt = await readPromptFileResolved(
      path.resolve("prompts/chronote-dictionary-teaching-chat.md"),
      path.resolve("prompts"),
    );

    expect(prompt).toMatchObject({
      name: "chronote-dictionary-teaching-chat",
      type: "chat",
      labels: ["production"],
    });
    expect(prompt.prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "user" }),
      ]),
    );
  });
});
