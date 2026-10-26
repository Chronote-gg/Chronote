import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import { completedTextResponse } from "../../src/testSupport/openaiResponse";

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
  responses: { content: string; truncated?: boolean }[],
) => {
  jest.resetModules();
  let callIndex = 0;
  const responseCreate = jest.fn().mockImplementation(() => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    const result = {
      ...completedTextResponse(response.content),
      model: "provider-model-7",
    };
    return response.truncated
      ? {
          ...result,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }
      : result;
  });
  const createOpenAIClient = jest.fn(() => ({
    responses: { create: responseCreate },
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
    responseCreate,
    createOpenAIClient,
  };
};

describe("openaiChatService", () => {
  test("chat accumulates multi-call Responses output", async () => {
    const { module, responseCreate } = await loadModule([
      { content: "hello ", truncated: true },
      { content: "world" },
    ]);
    const meeting = buildMeeting();

    const output = await module.chat(
      meeting,
      {
        messages: [{ role: "user", content: "Write the meeting notes." }],
      },
      {
        traceName: "notes",
        generationName: "notes",
      },
    );

    expect(output).toBe("hello world");
    expect(responseCreate).toHaveBeenCalledTimes(2);
    const firstRequest = responseCreate.mock.calls[0][0];
    expect(firstRequest.safety_identifier).toBe("safety-id");
    expect(firstRequest.store).toBe(false);
    expect(firstRequest.input).toEqual(
      expect.arrayContaining([
        { role: "user", content: "Write the meeting notes." },
      ]),
    );
    expect(firstRequest).not.toHaveProperty("user");
  });

  test("chat rejects an empty completed response", async () => {
    const { module, responseCreate } = await loadModule([{ content: "" }]);
    const meeting = buildMeeting();

    await expect(module.chat(meeting, { messages: [] })).rejects.toThrow(
      "OpenAI Responses output empty.",
    );

    expect(responseCreate).toHaveBeenCalledTimes(1);
  });
});

test("records every continuation response with actual model and resolved prompt metadata", async () => {
  const { module } = await loadModule([
    { content: "one", truncated: true },
    { content: "two" },
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
