import { describe, expect, test } from "@jest/globals";
import { resolveLiveMeetingAttendees } from "../../src/services/liveMeetingService";
import type { MeetingData } from "../../src/types/meeting-data";
import type { Participant } from "../../src/types/participants";

const makeMeeting = (overrides?: Partial<MeetingData>): MeetingData =>
  ({
    guildId: "guild-1",
    meetingId: "meeting-1",
    voiceChannel: { id: "voice-1", name: "General" },
    startTime: new Date("2025-01-01T00:00:00.000Z"),
    attendance: new Set<string>(),
    participants: new Map<string, Participant>(),
    finishing: false,
    finished: false,
    ...overrides,
  }) as MeetingData;

describe("resolveLiveMeetingAttendees", () => {
  test("maps mention strings to display names when participants are available", () => {
    const participants = new Map<string, Participant>([
      [
        "123",
        {
          id: "123",
          username: "alpha",
          displayName: "Alpha",
          serverNickname: "Al",
          tag: "alpha#0001",
        },
      ],
      [
        "456",
        {
          id: "456",
          username: "beta",
          tag: "beta#0002",
        },
      ],
    ]);
    const attendance = new Set<string>(["<@123>", "<@!456>", "Guest"]);

    const meeting = makeMeeting({ attendance, participants });

    expect(resolveLiveMeetingAttendees(meeting)).toEqual([
      "Al",
      "beta",
      "Guest",
    ]);
  });
});
