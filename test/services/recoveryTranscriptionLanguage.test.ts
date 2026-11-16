/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { transcriptionInput } from "../../src/services/meetingRecoveryContent";
import { buildTranscriptionRequest } from "../../src/services/transcriptionRequest";
import { resetMockStore } from "../../src/repositories/mockStore";
import { recoveryFixture } from "./meetingRecoveryFixtures";

beforeEach(() => resetMockStore());

async function hintFor(language: unknown) {
  const { payload } = await recoveryFixture();
  if (payload.settings.availability !== "available")
    throw new Error("settings");
  payload.settings.value.transcription.language = language;
  const input = transcriptionInput(
    payload,
    new AbortController().signal,
    (run) => run(),
  );
  return input.languageHint;
}

test.each([
  ["a recording frozen with a fixed language", "ja", "ja"],
  ["a recording frozen with auto detection", "auto", undefined],
  ["a recording older than the language setting", undefined, "en"],
])("recovery of %s sends the frozen language", async (_, frozen, hint) => {
  await expect(hintFor(frozen)).resolves.toBe(hint);
});

test("the production request carries a language only when one is frozen", () => {
  expect(buildTranscriptionRequest("gpt-transcribe")).toEqual({
    model: "gpt-transcribe",
    temperature: 0,
    response_format: "json",
    include: ["logprobs"],
  });
  expect(buildTranscriptionRequest("gpt-4o-transcribe", "ja")).toMatchObject({
    language: "ja",
  });
});
