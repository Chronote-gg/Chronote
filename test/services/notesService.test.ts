import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";

const USER_ID = "200000000000000001";
const ROLE_ID = "300000000000000001";

const buildMeeting = (): MeetingData =>
  ({
    meetingId: "meeting-1",
    creator: { id: "user-1" },
    guild: { id: "guild-1" },
    voiceChannel: { id: "voice-1" },
    participants: new Map([[USER_ID, { id: USER_ID, username: "user-a" }]]),
  }) as MeetingData;

const loadModule = async (notesOutput = "notes output") => {
  jest.resetModules();
  const getNotesPrompt = jest.fn().mockResolvedValue({
    messages: [{ role: "system", content: "prompt" }],
    langfusePrompt: { name: "notes", version: 1, isFallback: false },
  });
  const resolvePromptVisibleRoleIds = jest.fn().mockReturnValue([ROLE_ID]);
  const chat = jest.fn().mockResolvedValue(notesOutput);

  jest.doMock("../../src/services/notesPromptService", () => ({
    getNotesPrompt,
    resolvePromptVisibleRoleIds,
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

  test("getNotes keeps mentions the model was actually given", async () => {
    const notes = `- <@${USER_ID}> drafts it, <@&${ROLE_ID}> reviews.`;
    const { module } = await loadModule(notes);

    expect(await module.getNotes(buildMeeting())).toBe(notes);
  });

  test("getNotes strips mention ids the model invented", async () => {
    const { module } = await loadModule(
      "- <@&399999999999999999> and <@299999999999999999> follow up.",
    );

    expect(await module.getNotes(buildMeeting())).toBe("- and follow up.");
  });
});
