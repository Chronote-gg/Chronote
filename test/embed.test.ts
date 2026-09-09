jest.mock("../src/services/configService", () => ({
  config: { frontend: { siteUrl: "https://chronote.test" } },
}));
jest.mock("../src/commands/summaryFeedback", () => ({
  buildSummaryFeedbackButtonIds: (key: string) => ({
    up: `summary_feedback_up:${key}`,
    down: `summary_feedback_down:${key}`,
  }),
}));
jest.mock("../src/commands/meetingName", () => ({
  MEETING_RENAME_PREFIX: "rename_meeting",
}));

import {
  updateMeetingProcessingMessage,
  updateMeetingSummaryMessage,
} from "../src/embed";
import { DiscordAPIError } from "discord.js";
import { updateActiveObservation } from "@langfuse/tracing";
jest.mock("@langfuse/tracing", () => ({ updateActiveObservation: jest.fn() }));
jest.mock("../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => true,
}));
import type { MeetingData } from "../src/types/meeting-data";

type EmbedPayload = { description?: string };
type EmbedLike = { toJSON?: () => EmbedPayload; data?: EmbedPayload };

describe("updateMeetingSummaryMessage", () => {
  afterEach(() => jest.restoreAllMocks());
  const fixture = () => ({
    meetingId: "meeting-1",
    guildId: "guild-1",
    startMessageId: "start",
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    attendance: new Set(),
    voiceChannel: { id: "voice", name: "Voice" },
    textChannel: {
      id: "text",
      messages: {
        fetch: jest.fn().mockResolvedValue({
          id: "start",
          edit: jest.fn().mockResolvedValue(undefined),
        }),
      },
      send: jest.fn(),
    },
    generateNotes: true,
    notesText: "Notes",
    summarySentence: "Summary",
  });
  const denied = () =>
    new DiscordAPIError(
      { code: 50013, message: "PRIVATE ERROR BODY" },
      50013,
      403,
      "POST",
      "https://discord.test/secret",
      { json: { secret: "PRIVATE REQUEST" }, files: [] },
    );

  it("reports failed notes independently of successful summary editing without leaking error bodies", async () => {
    const value = fixture();
    value.textChannel.send.mockRejectedValue(denied());
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const result = await updateMeetingSummaryMessage(
      value as unknown as MeetingData,
    );
    expect(result).toMatchObject({
      summary: { outcome: "edited_existing", sent: 1 },
      notes: {
        outcome: "failed",
        intended: 1,
        sent: 0,
        errors: [{ code: 50013, status: 403 }],
      },
    });
    expect(value.generateNotes).toBe(true);
    expect(updateActiveObservation).toHaveBeenCalledWith(
      expect.objectContaining({ level: "ERROR" }),
      { asType: "chain" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE|discord.test/);
    warn.mockRestore();
  });

  it("retains acknowledged messages and reports partial notes when one batch fails", async () => {
    const value = fixture();
    value.notesText = "A".repeat(44000);
    value.textChannel.send
      .mockResolvedValueOnce({ id: "notes-1" })
      .mockRejectedValueOnce(denied());
    const meeting = value as unknown as MeetingData;
    const result = await updateMeetingSummaryMessage(meeting);
    expect(result).toMatchObject({
      notes: { outcome: "partial", intended: 2, sent: 1 },
    });
    expect(meeting.notesMessageIds).toEqual(["notes-1"]);
  });

  it("reports total processing failure without throwing or exposing arbitrary errors", async () => {
    const value = fixture();
    value.textChannel.messages.fetch.mockRejectedValue(
      new Error("PRIVATE FETCH"),
    );
    value.textChannel.send.mockRejectedValue(denied());
    await expect(
      updateMeetingProcessingMessage(value as unknown as MeetingData),
    ).resolves.toMatchObject({ outcome: "failed", intended: 1, sent: 0 });
  });

  it("reports a successful fallback with sanitized evidence of the failed edit", async () => {
    const value = fixture();
    value.textChannel.messages.fetch.mockRejectedValue(denied());
    value.textChannel.send.mockResolvedValue({ id: "replacement" });
    await expect(
      updateMeetingProcessingMessage(value as unknown as MeetingData),
    ).resolves.toEqual({
      outcome: "sent_fallback",
      intended: 1,
      sent: 1,
      errors: [{ code: 50013, status: 403 }],
    });
  });

  it("does not let unavailable telemetry turn an acknowledged send into a retry or failure", async () => {
    const value = fixture();
    value.textChannel.send.mockResolvedValue({ id: "notes" });
    jest.mocked(updateActiveObservation).mockImplementationOnce(() => {
      throw new Error("telemetry unavailable");
    });
    const result = await updateMeetingSummaryMessage(
      value as unknown as MeetingData,
    );
    expect(result).toMatchObject({
      summary: { outcome: "edited_existing" },
      notes: { outcome: "complete", sent: 1 },
    });
    expect(value.textChannel.send).toHaveBeenCalledTimes(1);
  });
  it("edits the start message when available", async () => {
    const message = {
      id: "start-message",
      edit: jest.fn().mockResolvedValue(undefined),
    };
    const notesMessage = {
      id: "notes-message",
    };
    const textChannel = {
      id: "text-1",
      messages: { fetch: jest.fn().mockResolvedValue(message) },
      send: jest.fn().mockResolvedValue(notesMessage),
    };
    const meeting = {
      meetingId: "meeting-1",
      guildId: "guild-1",
      startMessageId: "start-message",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: new Date("2025-01-01T01:00:00.000Z"),
      attendance: new Set(["User One"]),
      voiceChannel: { id: "voice-1", name: "Voice" },
      textChannel,
      generateNotes: true,
      notesText: "Notes content.",
      summarySentence: "Summary text.",
      tags: ["tag-1"],
    } as unknown as MeetingData;

    await updateMeetingSummaryMessage(meeting);

    expect(textChannel.messages.fetch).toHaveBeenCalledWith("start-message");
    expect(message.edit).toHaveBeenCalled();
    const editPayload = message.edit.mock.calls[0][0];
    expect(editPayload.embeds).toHaveLength(1);
    const summaryEmbed =
      editPayload.embeds[0].toJSON?.() ?? editPayload.embeds[0].data;
    expect(summaryEmbed?.description).toContain("Summary text.");
    expect(textChannel.send).toHaveBeenCalledTimes(1);
    const sendPayload = textChannel.send.mock.calls[0][0];
    const notesEmbed =
      sendPayload.embeds[0].toJSON?.() ?? sendPayload.embeds[0].data;
    expect(notesEmbed?.description).toContain("Notes content.");
    expect(meeting.summaryMessageId).toBe("start-message");
    expect(meeting.notesMessageIds).toEqual(["notes-message"]);
    expect(meeting.notesChannelId).toBe("text-1");
  });

  it("sends a new message when the start message cannot be edited", async () => {
    const message = {
      id: "new-message",
      edit: jest.fn().mockResolvedValue(undefined),
    };
    const notesMessage = {
      id: "notes-message",
    };
    const textChannel = {
      id: "text-2",
      messages: { fetch: jest.fn().mockRejectedValue(new Error("missing")) },
      send: jest
        .fn()
        .mockResolvedValueOnce(message)
        .mockResolvedValueOnce(notesMessage),
    };
    const meeting = {
      meetingId: "meeting-2",
      guildId: "guild-2",
      startMessageId: "missing-message",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: new Date("2025-01-01T01:00:00.000Z"),
      attendance: new Set(["User Two"]),
      voiceChannel: { id: "voice-2", name: "Voice" },
      textChannel,
      generateNotes: true,
      notesText: "Notes content.",
      summarySentence: "Summary text.",
    } as unknown as MeetingData;

    await updateMeetingSummaryMessage(meeting);

    expect(textChannel.send).toHaveBeenCalledTimes(2);
    const sendPayload = textChannel.send.mock.calls[0][0];
    expect(sendPayload.embeds).toHaveLength(1);
    expect(meeting.startMessageId).toBe("new-message");
    expect(meeting.summaryMessageId).toBe("new-message");
    expect(meeting.notesMessageIds).toEqual(["notes-message"]);
    expect(meeting.notesChannelId).toBe("text-2");
  });
  it("handles empty notes text by posting a fallback embed", async () => {
    const message = {
      id: "start-message",
      edit: jest.fn().mockResolvedValue(undefined),
    };
    const notesMessage = {
      id: "notes-message",
    };
    const textChannel = {
      id: "text-3",
      messages: { fetch: jest.fn().mockResolvedValue(message) },
      send: jest.fn().mockResolvedValue(notesMessage),
    };
    const meeting = {
      meetingId: "meeting-3",
      guildId: "guild-3",
      startMessageId: "start-message",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: new Date("2025-01-01T01:00:00.000Z"),
      attendance: new Set(["User Three"]),
      voiceChannel: { id: "voice-3", name: "Voice" },
      textChannel,
      generateNotes: true,
      notesText: "   ",
      summarySentence: "Summary text.",
    } as unknown as MeetingData;

    await updateMeetingSummaryMessage(meeting);

    const sendPayload = textChannel.send.mock.calls[0][0];
    expect(sendPayload.embeds).toHaveLength(1);
    const notesEmbed =
      sendPayload.embeds[0].toJSON?.() ?? sendPayload.embeds[0].data;
    expect(notesEmbed?.description).toContain("Notes unavailable.");
  });

  it("chunks long notes across multiple embeds", async () => {
    const message = {
      id: "start-message",
      edit: jest.fn().mockResolvedValue(undefined),
    };
    const notesMessage = {
      id: "notes-message",
    };
    const textChannel = {
      id: "text-4",
      messages: { fetch: jest.fn().mockResolvedValue(message) },
      send: jest.fn().mockResolvedValue(notesMessage),
    };
    const longNotes = "A".repeat(9000);
    const meeting = {
      meetingId: "meeting-4",
      guildId: "guild-4",
      startMessageId: "start-message",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      endTime: new Date("2025-01-01T01:00:00.000Z"),
      attendance: new Set(["User Four"]),
      voiceChannel: { id: "voice-4", name: "Voice" },
      textChannel,
      generateNotes: true,
      notesText: longNotes,
      summarySentence: "Summary text.",
    } as unknown as MeetingData;

    await updateMeetingSummaryMessage(meeting);

    const sendPayload = textChannel.send.mock.calls[0][0];
    expect(sendPayload.embeds.length).toBeGreaterThan(1);
    const descriptions = (sendPayload.embeds as EmbedLike[]).map((embed) => {
      const payload = embed.toJSON?.() ?? embed.data;
      return payload?.description ?? "";
    });
    expect(descriptions.join("").length).toBe(longNotes.length);
  });
});
