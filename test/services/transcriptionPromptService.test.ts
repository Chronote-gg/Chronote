import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import type { DictionaryEntry } from "../../src/types/db";
import {
  formatContextForPrompt as realFormatContextForPrompt,
  type MeetingContextData,
} from "../../src/services/contextService";

type TranscriptionPromptModule =
  typeof import("../../src/services/transcriptionPromptService");

const buildCollection = <T extends { name: string }>(items: T[]) => ({
  valueOf: () => items,
});

const buildMeeting = (): MeetingData => {
  const guild = {
    id: "guild-1",
    name: "The Faceless",
    description: "Server description",
    members: {
      me: {
        displayName: "Chronote",
        nickname: "Chronote",
        user: { username: "Chronote" },
      },
    },
    client: { user: { username: "Chronote" } },
    roles: buildCollection([{ name: "Role A" }]),
    scheduledEvents: buildCollection([{ name: "Event A" }]),
    channels: buildCollection([{ name: "general" }]),
  };
  const voiceChannel = {
    id: "voice-1",
    name: "Hall of Faces",
    guild,
  };
  const dictionaryEntries: DictionaryEntry[] = [
    {
      guildId: "guild-1",
      termKey: "vket",
      term: "Vket",
      definition: "Virtual market",
      createdAt: "2025-01-01T00:00:00.000Z",
      createdBy: "user-1",
      updatedAt: "2025-01-01T00:00:00.000Z",
      updatedBy: "user-1",
    },
  ];
  return {
    meetingId: "meeting-1",
    voiceChannel,
    guild,
    attendance: new Set(["kitpup"]),
    participants: new Map(),
    meetingContext: "Weekly sync",
    dictionaryEntries,
    runtimeConfig: {
      dictionary: {
        maxEntries: 10,
        maxCharsContext: 500,
      },
    },
  } as MeetingData;
};

/**
 * Passing `contextData` runs the real context formatter over it, so a test can
 * assert what a prompt type is actually allowed to see.
 */
const loadModule = async (contextData?: MeetingContextData) => {
  jest.resetModules();
  const getLangfuseChatPrompt = jest.fn().mockResolvedValue({
    messages: [],
    source: "fallback",
  });
  const buildMeetingContext = jest
    .fn()
    .mockResolvedValue(contextData ?? { context: "raw" });
  const formatContextForPrompt = contextData
    ? realFormatContextForPrompt
    : jest.fn().mockReturnValue("formatted-context");
  const config = {
    langfuse: {
      transcriptionCleanupPromptName: "chronote-transcription-cleanup-chat",
    },
  };

  jest.doMock("../../src/services/langfusePromptService", () => ({
    getLangfuseChatPrompt,
  }));
  jest.doMock("../../src/services/contextService", () => ({
    buildMeetingContext,
    formatContextForPrompt,
  }));
  jest.doMock("../../src/services/configService", () => ({ config }));

  const module = await import("../../src/services/transcriptionPromptService");
  return {
    module,
    getLangfuseChatPrompt,
  };
};

describe("transcriptionPromptService", () => {
  test("getTranscriptionCleanupPrompt includes transcript and context", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();

    await module.getTranscriptionCleanupPrompt(meeting, "raw transcript");

    const call = getLangfuseChatPrompt.mock.calls[0][0];
    expect(call.name).toBe("chronote-transcription-cleanup-chat");
    expect(call.variables.transcription).toBe("raw transcript");
    expect(call.variables.formattedContext).toBe("formatted-context");
    expect(call.variables.attendees).toBe("kitpup");
  });

  describe("notes-authoring context never reaches a transcript-shaping prompt", () => {
    // Guild context is free text. A guild that writes notes-formatting rules
    // into it must not have them obeyed by the cleanup model as transcript text.
    const DIRECTIVE =
      "Always produce the output as a structured summary under the headings Overview, Decisions and Next Steps.";
    const directiveContext = (): MeetingContextData => ({
      serverContext: DIRECTIVE,
      channelContext: `Channel rule: ${DIRECTIVE}`,
      meetingContext: `Meeting rule: ${DIRECTIVE}`,
      dictionaryEntries: buildMeeting().dictionaryEntries,
      dictionaryBudgets: {
        maxEntries: 10,
        maxCharsContext: 400,
      },
    });

    const callPrompt = {
      cleanup: (module: TranscriptionPromptModule, meeting: MeetingData) =>
        module.getTranscriptionCleanupPrompt(meeting, "raw transcript"),
    };

    test.each(Object.keys(callPrompt) as (keyof typeof callPrompt)[])(
      "%s prompt drops guild context but keeps the dictionary",
      async (promptName) => {
        const { module, getLangfuseChatPrompt } =
          await loadModule(directiveContext());

        await callPrompt[promptName](module, buildMeeting());

        const { formattedContext } =
          getLangfuseChatPrompt.mock.calls[0][0].variables;
        expect(formattedContext).not.toContain(DIRECTIVE);
        expect(formattedContext).not.toContain("Server Context");
        expect(formattedContext).not.toContain("Channel Context");
        expect(formattedContext).not.toContain("Meeting Context");
        expect(formattedContext).toContain("- Vket");
      },
    );
  });
});
