import { completedTextResponse } from "../../src/testSupport/openaiResponse";
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

const loadModule = async (notesOutput = "notes output", realChat = false) => {
  jest.resetModules();
  const getNotesPrompt = jest.fn().mockResolvedValue({
    messages: [{ role: "system", content: "prompt" }],
    langfusePrompt: { name: "notes", version: 1, isFallback: false },
    promptVisibleRoleIds: [ROLE_ID],
  });
  const chat = jest.fn().mockResolvedValue(notesOutput);

  jest.doMock("../../src/services/notesPromptService", () => ({
    getNotesPrompt,
  }));
  jest.doMock("../../src/services/openaiChatService", () =>
    realChat
      ? jest.requireActual("../../src/services/openaiChatService")
      : { chat },
  );
  const end = jest.fn();
  const startObservation = jest.fn(() => ({ end }));
  jest.doMock("@langfuse/tracing", () => ({ startObservation }));
  jest.doMock("../../src/services/langfuseClient", () => ({
    isLangfuseTracingEnabled: () => true,
  }));

  const module = await import("../../src/services/notesService");
  return { module, chat, getNotesPrompt, startObservation, end };
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

test("final notes telemetry emits one sanitized artifact after continuation", async () => {
  const create = jest
    .fn()
    .mockResolvedValueOnce({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "First part. ",
      output: [],
    })
    .mockResolvedValueOnce(
      completedTextResponse("Last part. <@299999999999999999>"),
    );
  jest.doMock("../../src/services/openaiClient", () => ({
    createOpenAIClient: () => ({ responses: { create } }),
    buildOpenAISafetyIdentifier: () => "synthetic",
  }));
  const fixture = await loadModule("", true);
  const { module, startObservation, end } = fixture;
  expect(await module.getNotes(buildMeeting())).toBe("First part. Last part. ");
  expect(startObservation).toHaveBeenCalledWith(
    "notes-final-artifact",
    {
      input: [{ role: "system", content: "prompt" }],
      output: "First part. Last part. ",
    },
    { parentSpanContext: undefined },
  );
  jest.doMock("../../src/services/langfusePromptService", () => ({
    getLangfuseChatPrompt: fixture.getNotesPrompt,
  }));
  const { generateMeetingSummaries } =
    await import("../../src/services/meetingSummaryService");
  const parent = {
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    traceFlags: 1,
  };
  create.mockResolvedValueOnce(
    completedTextResponse('{"summarySentence":" S ","summaryLabel":" L "}'),
  );
  await generateMeetingSummaries({
    notes: "notes",
    serverName: "server",
    channelName: "channel",
    recentMeetingNames: "",
    parentSpanContext: parent,
  });
  expect(startObservation).toHaveBeenCalledTimes(2);
  expect(startObservation).toHaveBeenLastCalledWith(
    "meeting-summary-final-artifact",
    {
      input: [{ role: "system", content: "prompt" }],
      output: { summarySentence: "S", summaryLabel: "L" },
    },
    { asType: "span", parentSpanContext: parent },
  );
  expect(end).toHaveBeenCalledTimes(2);
});

test("telemetry failure preserves finalized notes", async () => {
  const { module, startObservation } = await loadModule();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  startObservation.mockImplementation(() => {
    throw new Error("synthetic telemetry failure");
  });
  await expect(module.getNotes(buildMeeting())).resolves.toBe("notes output");
  expect(warn).toHaveBeenCalledWith("Final notes telemetry unavailable");
  warn.mockRestore();
});
