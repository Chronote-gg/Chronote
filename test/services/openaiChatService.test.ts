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

const loadModule = async (responses: { content: string; finish: string }[]) => {
  jest.resetModules();
  let callIndex = 0;
  const completionCreate = jest.fn().mockImplementation(() => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    return {
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
  });
});
