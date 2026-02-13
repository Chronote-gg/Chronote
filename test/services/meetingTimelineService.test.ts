import { expect, test } from "@jest/globals";
import type { ChatEntry } from "../../src/types/chat";
import type { MeetingHistory } from "../../src/types/db";
import type { MeetingData } from "../../src/types/meeting-data";
import type { Participant } from "../../src/types/participants";
import type { TranscriptPayload } from "../../src/types/transcript";
import {
  MEETING_END_REASONS,
  MEETING_STATUS,
} from "../../src/types/meetingLifecycle";
import {
  buildLiveMeetingTimelineEvents,
  buildMeetingTimelineEventsFromHistory,
} from "../../src/services/meetingTimelineService";

const buildHistory = (
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: "guild-1",
  channelId_timestamp: "voice-1#2025-01-01T00:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "voice-1",
  timestamp: "2025-01-01T00:00:00.000Z",
  participants: [],
  duration: 120,
  transcribeMeeting: true,
  generateNotes: true,
  updatedAt: "2025-01-01T00:02:00.000Z",
  ...overrides,
});

const buildParticipant = (id: string, name: string): Participant => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
});

test("buildMeetingTimelineEventsFromHistory merges transcript, chat, notes, and end events", () => {
  const participants = [
    buildParticipant("u1", "Alex"),
    buildParticipant("u2", "Blake"),
  ];
  const history = buildHistory({
    participants,
    notesChannelId: "text-1",
    notesMessageIds: ["note-1"],
    endReason: MEETING_END_REASONS.BUTTON,
    endTriggeredByUserId: "u2",
    status: MEETING_STATUS.COMPLETE,
  });
  const transcriptPayload: TranscriptPayload = {
    segments: [
      {
        userId: "u1",
        startedAt: "2025-01-01T00:00:05.000Z",
        text: "Hello",
        source: "voice",
      },
      {
        userId: "u1",
        startedAt: "2025-01-01T00:00:06.000Z",
        text: "Chat TTS",
        source: "chat_tts",
        messageId: "m1",
      },
      {
        userId: "u1",
        startedAt: "2025-01-01T00:00:07.000Z",
        text: "Bot message",
        source: "bot",
      },
    ],
  };
  const chatEntries: ChatEntry[] = [
    {
      type: "message",
      user: participants[0],
      channelId: "voice-1",
      content: "Should be skipped",
      messageId: "m1",
      timestamp: "2025-01-01T00:00:06.500Z",
    },
    {
      type: "message",
      user: participants[0],
      channelId: "voice-1",
      content: "Should be included",
      messageId: "m2",
      timestamp: "2025-01-01T00:00:08.000Z",
    },
  ];

  const events = buildMeetingTimelineEventsFromHistory({
    history,
    transcriptPayload,
    chatEntries,
  });

  expect(
    events.some((event) => event.type === "tts" && event.messageId === "m1"),
  ).toBe(true);
  expect(
    events.some((event) => event.type === "chat" && event.messageId === "m1"),
  ).toBe(false);
  expect(
    events.some((event) => event.type === "chat" && event.messageId === "m2"),
  ).toBe(true);
  expect(
    events.some((event) => event.text.includes("Meeting summary posted")),
  ).toBe(true);
  expect(
    events.some((event) => event.text.includes("Meeting ended by Blake")),
  ).toBe(true);
});

test("buildMeetingTimelineEventsFromHistory marks transcript unavailable", () => {
  const history = buildHistory({
    endReason: MEETING_END_REASONS.UNKNOWN,
  });

  const events = buildMeetingTimelineEventsFromHistory({ history });

  expect(events.some((event) => event.text === "Transcript unavailable.")).toBe(
    true,
  );
});

test("buildLiveMeetingTimelineEvents dedupes chat TTS and includes end events", () => {
  const participant = buildParticipant("u1", "Alex");
  const meeting = {
    meetingId: "meeting-1",
    chatLog: [
      {
        type: "message",
        user: participant,
        channelId: "voice-1",
        content: "Should be skipped",
        messageId: "m1",
        timestamp: "2025-01-01T00:00:06.500Z",
      },
      {
        type: "message",
        user: participant,
        channelId: "voice-1",
        content: "Should be included",
        messageId: "m2",
        timestamp: "2025-01-01T00:00:09.000Z",
      },
    ],
    attendance: new Set<string>(),
    connection: {},
    textChannel: {},
    voiceChannel: { id: "voice-1", name: "General" },
    guildId: "guild-1",
    channelId: "voice-1",
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [
        {
          userId: "u1",
          timestamp: Date.parse("2025-01-01T00:00:05.000Z"),
          transcript: "Chat TTS",
          source: "chat_tts",
          messageId: "m1",
          processing: false,
          audioOnlyProcessing: false,
        },
        {
          userId: "u1",
          timestamp: Date.parse("2025-01-01T00:00:07.000Z"),
          transcript: "Voice line",
          source: "voice",
          processing: false,
          audioOnlyProcessing: false,
        },
      ],
      cueEvents: [
        {
          userId: "u1",
          timestamp: Date.parse("2025-01-01T00:00:08.000Z"),
          text: "Bot cue",
          source: "bot",
        },
      ],
    },
    startTime: new Date("2025-01-01T00:00:00.000Z"),
    endTime: new Date("2025-01-01T00:02:00.000Z"),
    creator: { id: "u1" },
    guild: {
      members: { cache: new Map() },
      client: { users: { cache: new Map() } },
    },
    isAutoRecording: false,
    finishing: false,
    isFinished: Promise.resolve(),
    setFinished: () => {},
    finished: false,
    transcribeMeeting: true,
    generateNotes: true,
    participants: new Map([["u1", participant]]),
    notesChannelId: "text-1",
    notesMessageIds: ["note-1"],
    endReason: MEETING_END_REASONS.BUTTON,
    endTriggeredByUserId: "u1",
  } as MeetingData;

  const events = buildLiveMeetingTimelineEvents(meeting);

  expect(
    events.some((event) => event.type === "tts" && event.messageId === "m1"),
  ).toBe(true);
  expect(
    events.some((event) => event.type === "chat" && event.messageId === "m1"),
  ).toBe(false);
  expect(
    events.some((event) => event.type === "chat" && event.messageId === "m2"),
  ).toBe(true);
  expect(
    events.some((event) => event.text.includes("Meeting summary posted")),
  ).toBe(true);
  expect(
    events.some((event) => event.text.includes("Meeting ended by Alex")),
  ).toBe(true);
});

test("buildMeetingTimelineEventsFromHistory includes attachments-only chat messages", () => {
  const participant = buildParticipant("u1", "Alex");
  const history = buildHistory({
    participants: [participant],
  });
  const chatEntries: ChatEntry[] = [
    {
      type: "message",
      user: participant,
      channelId: "voice-1",
      content: "",
      attachments: [
        {
          id: "a1",
          name: "diagram.png",
          size: 1024,
          url: "https://example.com/diagram.png",
        },
      ],
      messageId: "m3",
      timestamp: "2025-01-01T00:00:10.000Z",
    },
  ];

  const events = buildMeetingTimelineEventsFromHistory({
    history,
    chatEntries,
  });

  const chatEvent = events.find(
    (event) => event.type === "chat" && event.messageId === "m3",
  );
  expect(chatEvent).toBeDefined();
  expect(chatEvent?.attachments?.[0]?.name).toBe("diagram.png");
  expect(chatEvent?.text).toContain("Shared 1 attachment");
});
