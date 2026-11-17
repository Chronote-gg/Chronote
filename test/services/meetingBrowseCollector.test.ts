/** @jest-environment node */
import { collectMeetingBrowsePage } from "../../src/services/meetingBrowseCollector";
import type { MeetingBrowseCursorPayload } from "../../src/services/meetingBrowseCursor";

function browseState(): MeetingBrowseCursorPayload {
  return {
    version: 2,
    actorId: "actor",
    filterFingerprint: "filters",
    requestFingerprint: "request",
    startTimestamp: "2026-01-01T00:00:00.000Z",
    endTimestamp: "2026-01-02T00:00:00.000Z",
    expiresAt: Date.now() + 3600000,
    sources: Array.from({ length: 9 }, (_, index) => ({
      kind: "guild",
      id: `guild-${index}`,
      exhausted: false,
    })),
    pending: [],
  };
}

test("loads nine independent source frontiers in three bounded IO rounds", async () => {
  jest.useFakeTimers();
  let active = 0;
  let peak = 0;
  let finished = false;
  const state = browseState();
  const read = jest.fn(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    active--;
    return { items: [] };
  });
  const authorize = jest.fn();
  const result = collectMeetingBrowsePage({
    state,
    limit: 25,
    read,
    authorize,
  });
  void result.then(() => {
    finished = true;
  });
  try {
    await jest.advanceTimersByTimeAsync(300);
    expect(finished).toBe(true);
    expect(peak).toBe(4);
    expect(read).toHaveBeenCalledTimes(9);
    expect(authorize).not.toHaveBeenCalled();
    await expect(result).resolves.toEqual({
      meetings: [],
      discoveryComplete: true,
    });
  } finally {
    await jest.runAllTimersAsync();
    jest.useRealTimers();
  }
});

test("concurrent empty-page reads share the request work budget", async () => {
  const state = browseState();
  const read = jest.fn(async () => ({
    items: [],
    nextCursor: { marker: { S: "continue" } },
  }));
  const authorize = jest.fn();
  await expect(
    collectMeetingBrowsePage({ state, limit: 25, read, authorize }),
  ).resolves.toEqual({ meetings: [], discoveryComplete: false });
  expect(read).toHaveBeenCalledTimes(1000);
  expect(authorize).not.toHaveBeenCalled();
  expect(state.sources.every((source) => !source.exhausted)).toBe(true);
});
