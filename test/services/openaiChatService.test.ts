import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";

const buildMeeting = (): MeetingData =>
  ({
    meetingId: "meeting-1",
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    voiceChannel: { id: "voice-1" },
    runtimeConfig: {
      modelParams: {},
      modelChoices: {},
    },
  }) as MeetingData;

const loadModule = async (
  responses: { content: string | null; finish: string }[],
) => {
  jest.resetModules();
  let callIndex = 0;
  const completionCreate = jest.fn().mockImplementation(() => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    return {
      model: "provider-model-7",
      choices: [
        {
          finish_reason: response.finish,
          message: { content: response.content },
        },
      ],
    };
  });
  const createOpenAIClient = jest.fn(() => ({
    chat: { completions: { create: completionCreate } },
  }));
  const getModelChoice = jest.fn(() => ({ model: "gpt-test" }));
  const resolveChatParamsForRole = jest.fn(() => ({}));

  jest.doMock("../../src/services/openaiClient", () => ({
    buildOpenAISafetyIdentifier: jest.fn(() => "safety-id"),
    createOpenAIClient,
  }));
  jest.doMock("../../src/services/modelFactory", () => ({ getModelChoice }));
  jest.doMock("../../src/services/meetingModelOverrides", () => ({
    getMeetingModelOverrides: jest.fn(),
  }));
  jest.doMock("../../src/services/openaiModelParams", () => ({
    resolveChatParamsForRole,
  }));

  const module = await import("../../src/services/openaiChatService");
  return {
    module,
    completionCreate,
    createOpenAIClient,
  };
};

describe("openaiChatService", () => {
  test("chat accumulates multi-call responses", async () => {
    const { module, completionCreate } = await loadModule([
      { content: "hello ", finish: "length" },
      { content: "world", finish: "stop" },
    ]);
    const meeting = buildMeeting();

    const output = await module.chat(
      meeting,
      {
        messages: [],
      },
      {
        traceName: "notes",
        generationName: "notes",
      },
    );

    expect(output).toBe("hello world");
    expect(completionCreate).toHaveBeenCalledTimes(2);
    const firstRequest = completionCreate.mock.calls[0][0];
    expect(firstRequest.safety_identifier).toBe("safety-id");
    expect(firstRequest).not.toHaveProperty("user");
  });

  test("chat stops when content is empty", async () => {
    const { module, completionCreate } = await loadModule([
      { content: null, finish: "stop" },
    ]);
    const meeting = buildMeeting();

    const output = await module.chat(meeting, { messages: [] });

    expect(output).toBe("");
    expect(completionCreate).toHaveBeenCalledTimes(1);
  });
});

test("records every continuation response with actual model and resolved prompt metadata", async () => {
  const { module } = await loadModule([
    { content: "one", finish: "length" },
    { content: "two", finish: "stop" },
  ]);
  const acknowledged = jest.fn();
  const observeGeneration = jest.fn(() => acknowledged);
  const meeting = { ...buildMeeting(), observeGeneration };
  const prompt = { name: "notes-template", version: 8, isFallback: false };
  expect(
    await module.chat(
      meeting,
      { messages: [{ role: "user", content: "private input" }] },
      { langfusePrompt: prompt },
    ),
  ).toBe("onetwo");
  expect(observeGeneration.mock.calls).toEqual([
    ["notes", "gpt-test", prompt],
    ["notes", "gpt-test", prompt],
  ]);
  expect(acknowledged.mock.calls).toEqual([
    ["provider-model-7"],
    ["provider-model-7"],
  ]);
});
