/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { transcriptionInput } from "../../src/services/meetingRecoveryContent";
import { buildTranscriptionRequest } from "../../src/services/transcriptionRequest";
import { meetingTranscriptionLanguage } from "../../src/config/transcriptionLanguage";
import { generationContextSchema } from "../../src/types/recordingContent";
import { resetMockStore } from "../../src/repositories/mockStore";
import { recoveryFixture } from "./meetingRecoveryFixtures";

beforeEach(() => resetMockStore());

async function requestLanguageFor(frozen: string | undefined) {
  const { payload } = await recoveryFixture();
  if (payload.settings.availability !== "available")
    throw new Error("settings");
  const transcription: Record<string, unknown> = {
    ...payload.settings.value.transcription,
    language: frozen,
  };
  if (frozen === undefined) delete transcription.language;
  const context = generationContextSchema.parse({
    ...payload,
    settings: {
      availability: "available",
      value: { ...payload.settings.value, transcription },
    },
  });
  const input = transcriptionInput(
    context,
    new AbortController().signal,
    (run) => run(),
  );
  return buildTranscriptionRequest(
    "gpt-transcribe",
    meetingTranscriptionLanguage(input.runtimeConfig),
  ).language;
}

test.each([
  ["a recording frozen with a pinned language", "ja", "ja"],
  ["a recording frozen with auto detection", "auto", undefined],
  ["a recording older than the language setting", undefined, "en"],
])("recovery of %s honours the frozen language", async (_, frozen, sent) => {
  await expect(requestLanguageFor(frozen)).resolves.toBe(sent);
});
