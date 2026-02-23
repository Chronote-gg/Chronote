import { describe, expect, test, jest } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import type { DictionaryEntry } from "../../src/types/db";
import type { TranscriptVariant } from "../../src/types/audio";

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
        maxCharsTranscription: 200,
        maxCharsContext: 500,
      },
    },
  } as MeetingData;
};

const loadModule = async () => {
  jest.resetModules();
  const getLangfuseTextPrompt = jest.fn().mockResolvedValue({
    prompt: "",
    source: "fallback",
  });
  const getLangfuseChatPrompt = jest.fn().mockResolvedValue({
    messages: [],
    source: "fallback",
  });
  const buildMeetingContext = jest.fn().mockResolvedValue({ context: "raw" });
  const formatContextForPrompt = jest.fn().mockReturnValue("formatted-context");
  const config = {
    langfuse: {
      transcriptionPromptName: "chronote-transcription-prompt",
      transcriptionCleanupPromptName: "chronote-transcription-cleanup-chat",
      transcriptionCoalescePromptName: "chronote-transcription-coalesce-chat",
      transcriptionFinalPassPromptName:
        "chronote-transcription-final-pass-chat",
    },
  };

  jest.doMock("../../src/services/langfusePromptService", () => ({
    getLangfuseTextPrompt,
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
    getLangfuseTextPrompt,
    getLangfuseChatPrompt,
  };
};

describe("transcriptionPromptService", () => {
  test("getTranscriptionPrompt builds glossary variables", async () => {
    const { module, getLangfuseTextPrompt } = await loadModule();
    const meeting = buildMeeting();

    await module.getTranscriptionPrompt(meeting);

    const call = getLangfuseTextPrompt.mock.calls[0][0];
    expect(call.name).toBe("chronote-transcription-prompt");
    expect(call.variables.serverName).toBe("The Faceless");
    expect(call.variables.channelName).toBe("Hall of Faces");
    expect(call.variables.attendeesLine).toBe("Attendees: kitpup");
    expect(call.variables.dictionaryBlock).toContain("- Vket");
    expect(call.variables.meetingContextLine).toBe(
      "Meeting Context: Weekly sync",
    );
  });

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

  test("getTranscriptionCoalescePrompt formats fast transcripts", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();
    const input = {
      slowTranscript: "slow text",
      fastTranscripts: [
        {
          revision: 1,
          text: "fast text",
          createdAt: "2025-01-01T00:00:00.000Z",
        } as TranscriptVariant,
      ],
    };

    await module.getTranscriptionCoalescePrompt(meeting, input);

    const call = getLangfuseChatPrompt.mock.calls[0][0];
    expect(call.name).toBe("chronote-transcription-coalesce-chat");
    expect(call.variables.fastTranscriptBlock).toContain("(rev 1) fast text");
    expect(call.variables.slowTranscript).toBe("slow text");
  });

  test("getTranscriptionFinalPassPrompt formats baseline segments", async () => {
    const { module, getLangfuseChatPrompt } = await loadModule();
    const meeting = buildMeeting();

    await module.getTranscriptionFinalPassPrompt(meeting, {
      chunkIndex: 1,
      chunkCount: 3,
      chunkTranscript: "hello from finalized audio",
      previousChunkTail: "previous tail",
      chunkLogprobSummary: "avgLogprob=-0.2",
      baselineSegments: [
        {
          segmentId: "seg-1",
          speaker: "Kit",
          startedAt: "2025-01-01T00:00:00.000Z",
          text: "hello world",
        },
      ],
    });

    const call = getLangfuseChatPrompt.mock.calls[0][0];
    expect(call.name).toBe("chronote-transcription-final-pass-chat");
    expect(call.variables.chunkIndex).toBe("1");
    expect(call.variables.chunkCount).toBe("3");
    expect(call.variables.chunkTranscript).toBe("hello from finalized audio");
    expect(call.variables.baselineSegmentsBlock).toContain("[seg-1]");
  });
});
