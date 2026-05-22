import { describe, expect, test } from "@jest/globals";
import type { MeetingHistory } from "../../src/types/db";
import {
  buildAskCitations,
  renderAskAnswer,
  stripCitationTags,
} from "../../src/services/askCitations";

const buildMeeting = (
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: "guild-1",
  channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "voice-1",
  timestamp: "2025-01-01T00:00:00.000Z",
  participants: [],
  duration: 60,
  transcribeMeeting: true,
  generateNotes: true,
  ...overrides,
});

describe("askCitations", () => {
  test("builds citations from valid tags and dedupes", () => {
    const meetings = [
      buildMeeting({
        channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
      }),
      buildMeeting({
        channelId_timestamp: "voice-2#2025-01-02T00:00:00.000Z",
      }),
    ];
    const text =
      'Answer <chronote:cite index="1" /> ' +
      '<chronote:cite index="1" /> ' +
      '<chronote:cite index="2" /> ' +
      '<chronote:cite index="3" />';
    const citations = buildAskCitations({ text, meetings });

    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({
      index: 1,
      meetingId: meetings[0].channelId_timestamp,
    });
    expect(citations[1]).toMatchObject({
      index: 2,
      meetingId: meetings[1].channelId_timestamp,
    });
  });

  test("renders inline citations and strips tags", () => {
    const meetings = [
      buildMeeting({
        channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
      }),
    ];
    const text = 'Decision <chronote:cite index="1" />';
    const citations = buildAskCitations({ text, meetings });
    const rendered = renderAskAnswer({
      text,
      citations,
      guildId: "guild-1",
      portalBaseUrl: "https://app.example.com",
    });

    expect(rendered).toContain("Decision [1](");
    expect(rendered).toContain(
      "https://app.example.com/portal/meetings/guild-1/voice-1%232025-01-01T00%3A00%3A00.000Z",
    );
  });

  test("captures transcript event IDs", () => {
    const meetings = [
      buildMeeting({
        channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
      }),
    ];
    const text = 'Line <chronote:cite index="1" eventId="line-42" />';
    const citations = buildAskCitations({ text, meetings });
    const rendered = renderAskAnswer({
      text,
      citations,
      guildId: "guild-1",
      portalBaseUrl: "https://app.example.com",
    });

    expect(citations[0]?.eventId).toBe("line-42");
    expect(rendered).toContain("Line [1](");
    expect(rendered).toContain("eventId=line-42");
  });

  test("ignores tags that exceed the length cap", () => {
    const meetings = [
      buildMeeting({
        channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
      }),
    ];
    const longEventId = "a".repeat(600);
    const text = `Answer <chronote:cite index="1" eventId="${longEventId}" />`;
    const citations = buildAskCitations({ text, meetings });
    const rendered = renderAskAnswer({
      text,
      citations,
      guildId: "guild-1",
      portalBaseUrl: "https://app.example.com",
    });

    expect(citations).toHaveLength(0);
    expect(rendered).toBe("Answer");
  });

  test("strips citation tags from text", () => {
    const cleaned = stripCitationTags('Answer <chronote:cite index="1" />');
    expect(cleaned).toBe("Answer");
  });
});
