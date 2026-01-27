import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";

const buildMeeting = (): MeetingData =>
  ({
    meetingId: "meeting-1",
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    voiceChannel: { id: "voice-1" },
    finalTranscript: "Transcript text",
  }) as MeetingData;

const loadModule = async () => {
  jest.resetModules();
  const getLangfuseChatPrompt = jest.fn().mockResolvedValue({
    messages: [{ role: "system", content: "prompt" }],
    langfusePrompt: { name: "image", version: 1, isFallback: false },
  });
  const chat = jest.fn().mockResolvedValue("image prompt");
  const getModelChoice = jest.fn((role: string) => {
    if (role === "imagePrompt") {
      return { model: "gpt-image-prompt" };
    }
    return { model: "dall-e-3" };
  });
  const imagesGenerate = jest.fn().mockResolvedValue({
    data: [{ url: "https://example.com/image.png" }],
  });
  const createOpenAIClient = jest.fn(() => ({
    images: { generate: imagesGenerate },
  }));
  const buildMeetingContext = jest.fn().mockResolvedValue({ context: "raw" });
  const formatContextForPrompt = jest.fn().mockReturnValue("formatted-context");
  const config = {
    langfuse: {
      imagePromptName: "chronote-image-prompt-chat",
    },
  };

  jest.doMock("../../src/services/langfusePromptService", () => ({
    getLangfuseChatPrompt,
  }));
  jest.doMock("../../src/services/openaiChatService", () => ({ chat }));
  jest.doMock("../../src/services/modelFactory", () => ({ getModelChoice }));
  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient,
  }));
  jest.doMock("../../src/services/contextService", () => ({
    buildMeetingContext,
    formatContextForPrompt,
  }));
  jest.doMock("../../src/services/configService", () => ({ config }));
  jest.doMock("../../src/services/meetingModelOverrides", () => ({
    getMeetingModelOverrides: jest.fn(),
  }));

  const module = await import("../../src/services/imageService");
  return {
    module,
    chat,
    imagesGenerate,
    getModelChoice,
  };
};

describe("imageService", () => {
  test("getImage builds image prompt and calls image generation", async () => {
    const { module, chat, imagesGenerate, getModelChoice } = await loadModule();
    const meeting = buildMeeting();

    const output = await module.getImage(meeting);

    expect(output).toBe("https://example.com/image.png");
    expect(chat).toHaveBeenCalledWith(
      meeting,
      { messages: [{ role: "system", content: "prompt" }] },
      expect.objectContaining({
        model: "gpt-image-prompt",
        traceName: "image-prompt",
      }),
    );
    expect(getModelChoice).toHaveBeenCalledWith("imagePrompt", undefined);
    expect(getModelChoice).toHaveBeenCalledWith("image", undefined);
    expect(imagesGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "dall-e-3",
        prompt: "image prompt",
      }),
    );
  });
});
