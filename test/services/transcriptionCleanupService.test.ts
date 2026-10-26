/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SavedRecordingSettings } from "../../src/types/recordingContent";
import { chat } from "../../src/services/openaiChatService";
import { getTranscriptionCleanupPrompt } from "../../src/services/transcriptionPromptService";
import { getModelChoice } from "../../src/services/modelFactory";
import { resolveChatParamsForRole } from "../../src/services/openaiModelParams";
import {
  prepareTranscriptionCleanup,
  cleanupContentTranscription,
  retainCleanupTranscript,
} from "../../src/services/transcriptionCleanupService";

jest.mock("../../src/services/openaiChatService", () => ({ chat: jest.fn() }));
jest.mock("../../src/services/transcriptionPromptService", () => ({
  getTranscriptionCleanupPrompt: jest.fn(),
}));
jest.mock("../../src/services/modelFactory", () => ({
  getModelChoice: jest.fn(),
}));
jest.mock("../../src/services/openaiModelParams", () => ({
  resolveChatParamsForRole: jest.fn(),
}));
jest.mock("../../src/services/meetingModelOverrides", () => ({
  getMeetingModelOverrides: () => undefined,
}));

const content = {
  meetingId: "synthetic-cleanup",
  creator: { id: "synthetic-creator" },
  guild: { id: "synthetic-guild" },
  voiceChannel: { id: "synthetic-voice" },
};
const model: SavedRecordingSettings["models"]["transcriptionCleanup"] = {
  provider: "openai",
  model: "synthetic-model",
  params: { verbosity: "low" },
};
const prompt: Parameters<typeof cleanupContentTranscription>[1] = {
  messages: [{ role: "system", content: "Synthetic cleanup instruction" }],
  langfusePrompt: { name: "synthetic-prompt", version: 4, isFallback: false },
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(chat).mockReset().mockResolvedValue("Synthetic cleaned text");
  jest.mocked(getTranscriptionCleanupPrompt).mockResolvedValue({
    ...prompt,
    source: "langfuse",
  });
  jest.mocked(getModelChoice).mockReturnValue({
    provider: model.provider,
    model: model.model,
  });
  jest.mocked(resolveChatParamsForRole).mockReturnValue(model.params);
});
test("preparation keeps the transcript and resolves the live prompt and model once", async () => {
  const meeting = content as MeetingData;
  const prepared = await prepareTranscriptionCleanup(
    meeting,
    "Synthetic raw text",
  );
  expect(prepared).toEqual({
    transcription: "Synthetic raw text",
    prompt,
    model,
  });
  expect(getTranscriptionCleanupPrompt).toHaveBeenCalledWith(
    meeting,
    "Synthetic raw text",
  );
  expect(getModelChoice).toHaveBeenCalledWith(
    "transcriptionCleanup",
    undefined,
  );
  expect(resolveChatParamsForRole).toHaveBeenCalledWith({
    role: "transcriptionCleanup",
    model: model.model,
    config: undefined,
  });
  expect(chat).not.toHaveBeenCalled();
});
test("execution uses the supplied frozen prompt and model without live preparation", async () => {
  const output = await cleanupContentTranscription(content, prompt, model);
  expect(output).toBe("Synthetic cleaned text");
  expect(chat).toHaveBeenCalledWith(
    content,
    { messages: prompt.messages },
    {
      model: model.model,
      frozenModel: model,
      traceName: "transcription-cleanup",
      generationName: "transcription-cleanup",
      tags: ["feature:transcription_cleanup"],
      langfusePrompt: prompt.langfusePrompt,
      parentSpanContext: undefined,
      modelParamRole: "transcriptionCleanup",
    },
  );
  expect(getTranscriptionCleanupPrompt).not.toHaveBeenCalled();
  expect(getModelChoice).not.toHaveBeenCalled();
});
test("execution exposes a rejected optional cleanup request", async () => {
  const error = new Error("Synthetic cleanup rejection");
  jest.mocked(chat).mockRejectedValueOnce(error);
  await expect(
    cleanupContentTranscription(content, prompt, model),
  ).rejects.toBe(error);
});
test.each<[string, string, number, string]>([
  ["first\nsecond\nthird", "short", 0.8, "first\nsecond\nthird"],
  ["first\nsecond", "accepted\nreplacement", 0.8, "accepted\nreplacement"],
  ["unchanged", "unchanged", 0.8, "unchanged"],
  ["first\nsecond\nthird", "", 0.8, "first\nsecond\nthird"],
])(
  "retention preserves the existing line ratio for %j",
  (original, cleaned, ratio, expected) => {
    expect(retainCleanupTranscript(original, cleaned, ratio)).toBe(expected);
  },
);
