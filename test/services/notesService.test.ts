import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";

const buildMeeting = (): MeetingData =>
  ({
    meetingId: "meeting-1",
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    voiceChannel: { id: "voice-1" },
  }) as MeetingData;

const loadModule = async () => {
  jest.resetModules();
  const getNotesPrompt = jest.fn().mockResolvedValue({
    messages: [{ role: "system", content: "prompt" }],
    langfusePrompt: { name: "notes", version: 1, isFallback: false },
  });
  const chat = jest.fn().mockResolvedValue("notes output");

  jest.doMock("../../src/services/notesPromptService", () => ({
    getNotesPrompt,
  }));
  jest.doMock("../../src/services/openaiChatService", () => ({ chat }));

  const module = await import("../../src/services/notesService");
  return { module, chat, getNotesPrompt };
};

describe("notesService", () => {
  test("getNotes uses the notes prompt and chat helper", async () => {
    const { module, chat, getNotesPrompt } = await loadModule();
    const meeting = buildMeeting();

    const output = await module.getNotes(meeting);

    expect(output).toBe("notes output");
    expect(getNotesPrompt).toHaveBeenCalledWith(meeting);
    expect(chat).toHaveBeenCalledWith(
      meeting,
      { messages: [{ role: "system", content: "prompt" }] },
      expect.objectContaining({
        traceName: "notes",
        generationName: "notes",
      }),
    );
  });
});
