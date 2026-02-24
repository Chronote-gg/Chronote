import { describe, expect, test } from "@jest/globals";
import type { MeetingData } from "../../src/types/meeting-data";
import { isMeetingCollectingEvents } from "../../src/utils/meetingLifecycle";

const buildMeetingState = (
  overrides: Partial<Pick<MeetingData, "finishing" | "finished">> = {},
): MeetingData =>
  ({
    finishing: false,
    finished: false,
    ...overrides,
  }) as MeetingData;

describe("isMeetingCollectingEvents", () => {
  test("returns false when meeting is undefined", () => {
    expect(isMeetingCollectingEvents(undefined)).toBe(false);
  });

  test("returns true while a meeting is in progress", () => {
    expect(isMeetingCollectingEvents(buildMeetingState())).toBe(true);
  });

  test("returns false after end starts processing", () => {
    expect(
      isMeetingCollectingEvents(buildMeetingState({ finishing: true })),
    ).toBe(false);
  });

  test("returns false once a meeting is finished", () => {
    expect(
      isMeetingCollectingEvents(buildMeetingState({ finished: true })),
    ).toBe(false);
  });

  test("returns false when finishing and finished are both true", () => {
    expect(
      isMeetingCollectingEvents(
        buildMeetingState({ finishing: true, finished: true }),
      ),
    ).toBe(false);
  });
});
