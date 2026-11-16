jest.mock("openai", () => {
  throw new Error("Discord delivery imported OpenAI");
});
export {};
