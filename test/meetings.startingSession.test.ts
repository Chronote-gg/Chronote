/** @jest-environment node */
import type { MeetingInitOptions } from "../src/meetings";
import type { MeetingData } from "../src/types/meeting-data";

const mockStart: {
  run?: (options: MeetingInitOptions) => Promise<MeetingData>;
} = {};
jest.mock("../src/services/meetingStart", () => ({
  startMeetingSession: (options: MeetingInitOptions) => mockStart.run!(options),
}));

import {
  addMeeting,
  deleteMeeting,
  getMeeting,
  getStartingMeetingId,
  initializeMeeting,
} from "../src/meetings";

const GUILD = "synthetic-starting-guild";
const MEETING = "synthetic-starting-meeting";

function options(): MeetingInitOptions {
  const partial: Partial<MeetingInitOptions> = {
    meetingId: MEETING,
    guild: { id: GUILD } as never,
    voiceChannel: { id: "synthetic-voice" } as never,
    textChannel: { id: "synthetic-text" } as never,
    creator: { id: "synthetic-user" } as never,
  };
  return partial as MeetingInitOptions;
}

/** What routing sees at one instant: a live meeting, a start in progress, or neither. */
const localState = () =>
  getMeeting(GUILD)
    ? "live"
    : getStartingMeetingId(GUILD) === MEETING
      ? "starting"
      : "none";

test("a press at any point of a start finds this worker holding the session", async () => {
  const meeting = { guildId: GUILD, meetingId: MEETING } as MeetingData;
  const seen: string[] = [];
  mockStart.run = async () => {
    seen.push(localState());
    await Promise.resolve();
    addMeeting(meeting);
    seen.push(localState());
    return meeting;
  };
  const started = initializeMeeting(options());
  seen.push(localState());
  await started;
  seen.push(localState());
  // Every microtask between the start resolving and its key being removed.
  for (let tick = 0; tick < 3; tick++) {
    await Promise.resolve();
    seen.push(localState());
  }
  expect(seen).not.toContain("none");
  expect(seen.at(-1)).toBe("live");
  expect(getStartingMeetingId(GUILD)).toBeUndefined();
  deleteMeeting(meeting);
});

test("a failed start leaves no starting session behind", async () => {
  mockStart.run = async () => {
    throw new Error("synthetic start failure");
  };
  await expect(initializeMeeting(options())).rejects.toThrow(
    "synthetic start failure",
  );
  await Promise.resolve();
  expect(localState()).toBe("none");
});
