/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { transcriptionInput } from "../../src/services/meetingRecoveryContent";
import { buildTranscriptionRequest } from "../../src/services/transcriptionRequest";
import { meetingTranscriptionLanguage } from "../../src/config/transcriptionLanguage";
import { generationContextSchema } from "../../src/types/recordingContent";
import { resetMockStore } from "../../src/repositories/mockStore";
import { recoveryFixture } from "./meetingRecoveryFixtures";

beforeEach(() => resetMockStore());

async function recoveryRequest(options: {
  frozenLanguage?: string;
  model?: string;
  dictionaryEntries?: { term: string; updatedAt?: string }[];
}) {
  const { payload } = await recoveryFixture();
  if (payload.settings.availability !== "available")
    throw new Error("settings");
  const transcription: Record<string, unknown> = {
    ...payload.settings.value.transcription,
    language: options.frozenLanguage,
  };
  if (options.frozenLanguage === undefined) delete transcription.language;
  const model = options.model ?? "gpt-transcribe";
  const models = payload.settings.value.models;
  const context = generationContextSchema.parse({
    ...payload,
    context: {
      ...payload.context,
      dictionaryEntries: options.dictionaryEntries ?? [],
    },
    settings: {
      availability: "available",
      value: {
        ...payload.settings.value,
        transcription,
        models: {
          ...models,
          transcription: { ...models.transcription, model },
        },
      },
    },
  });
  const input = transcriptionInput(
    context,
    new AbortController().signal,
    (run) => run(),
  );
  return buildTranscriptionRequest(
    input.runtimeConfig!.modelChoices!.transcription!,
    meetingTranscriptionLanguage(input.runtimeConfig),
    input.keywords,
  );
}

test.each([
  ["a recording frozen with a pinned language", "ja", ["ja"]],
  ["a recording frozen with auto detection", "auto", undefined],
  ["a recording older than the language setting", undefined, ["en"]],
])("recovery of %s honours the frozen language", async (_, frozen, sent) => {
  const request = await recoveryRequest({ frozenLanguage: frozen });
  expect(request.languages).toEqual(sent);
  expect(request).not.toHaveProperty("language");
});

test("recovery with a frozen older model sends the singular language and no keywords", async () => {
  const request = await recoveryRequest({
    frozenLanguage: "ja",
    model: "gpt-4o-transcribe",
    dictionaryEntries: [{ term: "Kwylt" }],
  });
  expect(request.language).toBe("ja");
  expect(request).not.toHaveProperty("languages");
  expect(request).not.toHaveProperty("keywords");
});

test("recovery sends the saved dictionary terms as keywords", async () => {
  const request = await recoveryRequest({
    frozenLanguage: "auto",
    dictionaryEntries: [
      { term: "Xaerith", updatedAt: "2026-01-01T00:00:00.000Z" },
      { term: "Kwylt", updatedAt: "2026-02-01T00:00:00.000Z" },
    ],
  });
  expect(request.keywords).toEqual(["Kwylt", "Xaerith"]);
});
