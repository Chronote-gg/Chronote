import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import type { Participant } from "../../src/types/participants";
import type { ChatEntry } from "../../src/types/chat";

const buildCollection = <T>(items: T[]) => ({
  valueOf: () => items,
});

const GUILD_ID = "guild-1";
const ROLE_DESIGN_ID = "role-design";
const ROLE_ALUMNI_ID = "role-alumni";
const ROLE_BOT_ID = "role-bot";

const buildMeeting = (): MeetingData => {
  const guild = {
    id: GUILD_ID,
    name: "Server X",
    description: "Server description",
    members: {
      me: {
        displayName: "Chronote",
        nickname: "Chronote",
        user: { username: "Chronote" },
      },
    },
    roles: buildCollection([
      { id: ROLE_DESIGN_ID, name: "Design" },
      { id: ROLE_ALUMNI_ID, name: "Alumni" },
      { id: ROLE_BOT_ID, name: "Bot Role", managed: true },
      { id: GUILD_ID, name: "@everyone" },
    ]),
    scheduledEvents: buildCollection([{ name: "Event A" }]),
    channels: buildCollection([{ name: "general" }]),
  };
  const voiceChannel = {
    id: "voice-1",
    name: "Channel Y",
  };
  const participant: Participant = {
    id: "user-1",
    username: "user-a",
    displayName: "User A",
    serverNickname: "User A nick",
    roleIds: [ROLE_DESIGN_ID],
  };
  const chatLog: ChatEntry[] = [
    {
      type: "message",
      user: participant,
      channelId: "voice-1",
      content: "Hello there",
      timestamp: "2025-01-01T00:00:00.000Z",
    },
  ];
  return {
    meetingId: "meeting-1",
    voiceChannel,
    guild,
    chatLog,
    participants: new Map([[participant.id, participant]]),
    attendance: new Set(["user-a"]),
    finalTranscript: "Transcript text",
    runtimeConfig: {
      visionCaptions: {
        enabled: true,
        maxImages: 10,
        maxTotalChars: 3000,
      },
    },
  } as MeetingData;
};

const loadModule = async () => {
  jest.resetModules();
  const getLangfuseChatPrompt = jest.fn().mockResolvedValue({
    messages: [],
    source: "fallback",
  });
  const buildMeetingContext = jest.fn().mockResolvedValue({ context: "raw" });
  const formatContextForPrompt = jest.fn().mockReturnValue("formatted-context");
  const isMemoryEnabled = jest.fn().mockReturnValue(true);
  const config = {
    notes: {
      longStoryTestMode: false,
      longStoryTargetChars: 1500,
    },
    context: {
      testMode: false,
    },
    langfuse: {
      notesPromptName: "chronote-notes-system-chat",
      notesLongStoryPromptName: "chronote-notes-long-story-chat",
      notesContextTestPromptName: "chronote-notes-context-test-chat",
    },
  };

  jest.doMock("../../src/services/langfusePromptService", () => ({
    getLangfuseChatPrompt,
  }));
  jest.doMock("../../src/services/contextService", () => ({
    buildMeetingContext,
    formatContextForPrompt,
    isMemoryEnabled,
  }));
  jest.doMock("../../src/services/configService", () => ({ config }));

  const module = await import("../../src/services/notesPromptService");
  return { module, getLangfuseChatPrompt };
};

describe("notesPromptService", () => {
  test("getNotesPrompt includes chat context and roster", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();

    await module.getNotesPrompt(meeting);

    const call = getLangfuseChatPrompt.mock.calls[0][0];
    expect(call.name).toBe("chronote-notes-system-chat");
    expect(call.variables.chatContextInstruction).toContain(
      "Use participant chat messages",
    );
    expect(call.variables.chatContextInstruction).toContain(
      "untrusted context only",
    );
    expect(call.variables.chatContextBlock).toContain("Chat context");
    expect(call.variables.participantRoster).toContain("profile");
    expect(call.variables.attendees).toBe("user-a");
  });

  test("role roster lists mention strings and in-meeting counts", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();

    await module.getNotesPrompt(buildMeeting());

    const { roles } = getLangfuseChatPrompt.mock.calls[0][0].variables;
    expect(roles).toContain(`- Design | mention: <@&${ROLE_DESIGN_ID}>`);
    expect(roles).toContain("in this meeting: 1");
    expect(roles).toContain(`- Alumni | mention: <@&${ROLE_ALUMNI_ID}>`);
    expect(roles).toContain("in this meeting: 0");
  });

  test("role roster sorts roles held by participants first", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();

    await module.getNotesPrompt(buildMeeting());

    const { roles } = getLangfuseChatPrompt.mock.calls[0][0].variables;
    // Alumni sorts first alphabetically, so leading Design proves the sort is
    // driven by in-meeting membership rather than by name.
    expect(roles.indexOf("Design")).toBeLessThan(roles.indexOf("Alumni"));
  });

  test("role roster excludes @everyone and managed roles", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();

    await module.getNotesPrompt(buildMeeting());

    const { roles } = getLangfuseChatPrompt.mock.calls[0][0].variables;
    expect(roles).not.toContain("@everyone");
    expect(roles).not.toContain(GUILD_ID);
    expect(roles).not.toContain("Bot Role");
  });

  test("participant roster lists each participant's role names", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();

    await module.getNotesPrompt(buildMeeting());

    const { participantRoster } =
      getLangfuseChatPrompt.mock.calls[0][0].variables;
    expect(participantRoster).toContain("mention: <@user-1>");
    expect(participantRoster).toContain("roles: Design");
  });

  test("participant roster marks participants with no roles", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();
    meeting.participants.get("user-1")!.roleIds = undefined;

    await module.getNotesPrompt(meeting);

    const { participantRoster } =
      getLangfuseChatPrompt.mock.calls[0][0].variables;
    expect(participantRoster).toContain("roles: -");
  });

  test("role roster reports when a server has no mentionable roles", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();
    meeting.guild.roles = buildCollection([
      { id: GUILD_ID, name: "@everyone" },
    ]) as unknown as MeetingData["guild"]["roles"];

    await module.getNotesPrompt(meeting);

    expect(getLangfuseChatPrompt.mock.calls[0][0].variables.roles).toBe(
      module.NO_ROLES_AVAILABLE_TEXT,
    );
  });

  test("getNotesPrompt falls back when no chat log exists", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();
    meeting.chatLog = [];

    await module.getNotesPrompt(meeting);

    const call = getLangfuseChatPrompt.mock.calls[0][0];
    expect(call.variables.chatContextInstruction).toContain(
      "No additional participant chat was captured",
    );
    expect(call.variables.chatContextBlock).toBe("");
  });

  test("getNotesPrompt includes shared image captions when available", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();
    meeting.chatLog[0].attachments = [
      {
        id: "att-1",
        name: "diagram.png",
        size: 1234,
        url: "https://cdn.discordapp.com/attachments/mock/diagram.png",
        contentType: "image/png",
        aiCaption: "A sketch of the architecture.",
        aiVisibleText: "API -> Worker -> DB",
        aiCaptionModel: "gpt-4o-mini",
        aiCaptionedAt: "2025-01-01T00:00:01.000Z",
      },
    ];

    await module.getNotesPrompt(meeting);

    const call = getLangfuseChatPrompt.mock.calls[0][0];
    expect(call.variables.chatContextBlock).toContain(
      "Shared images (AI captions, OCR-lite)",
    );
    expect(call.variables.chatContextBlock).toContain("diagram.png");
    expect(call.variables.chatContextBlock).toContain("architecture");
    expect(call.variables.chatContextBlock).toContain("API");
  });

  test("getNotesPrompt omits shared image captions when disabled", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();
    meeting.runtimeConfig!.visionCaptions.enabled = false;
    meeting.chatLog[0].attachments = [
      {
        id: "att-1",
        name: "diagram.png",
        size: 1234,
        url: "https://cdn.discordapp.com/attachments/mock/diagram.png",
        contentType: "image/png",
        aiCaption: "A sketch of the architecture.",
        aiVisibleText: "API -> Worker -> DB",
        aiCaptionModel: "gpt-4o-mini",
        aiCaptionedAt: "2025-01-01T00:00:01.000Z",
      },
    ];

    await module.getNotesPrompt(meeting);

    const call = getLangfuseChatPrompt.mock.calls[0][0];
    expect(call.variables.chatContextBlock).not.toContain(
      "Shared images (AI captions, OCR-lite)",
    );
    expect(call.variables.chatContextBlock).not.toContain(
      "A sketch of the architecture.",
    );
    expect(call.variables.chatContextBlock).not.toContain(
      "API -> Worker -> DB",
    );
  });
});
