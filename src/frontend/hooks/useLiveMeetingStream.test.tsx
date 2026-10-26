import { act, renderHook } from "@testing-library/react";
import { useLiveMeetingStream, toStreamStatus } from "./useLiveMeetingStream";

jest.mock("../services/apiClient", () => ({
  buildApiUrl: (path: string) => path,
}));

class TestEventSource extends EventTarget {
  static latest: TestEventSource;
  static instances: TestEventSource[] = [];
  onerror: (() => void) | null = null;
  close = jest.fn();
  constructor() {
    super();
    TestEventSource.latest = this;
    TestEventSource.instances.push(this);
  }
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const originalEventSource = global.EventSource;
beforeEach(() => {
  TestEventSource.instances = [];
  Object.defineProperty(global, "EventSource", {
    configurable: true,
    value: TestEventSource,
  });
});
afterEach(() => {
  Object.defineProperty(global, "EventSource", {
    configurable: true,
    value: originalEventSource,
  });
});

it("replaces revised segments and removes later-suppressed segments", () => {
  const { result } = renderHook(() =>
    useLiveMeetingStream({
      guildId: "guild",
      meetingId: "meeting",
      enabled: true,
    }),
  );
  const source = TestEventSource.latest;
  const voice = {
    id: "voice-1",
    type: "voice",
    time: "0:10",
    speaker: "Alice",
    text: "A first guess",
  };
  act(() =>
    source.emit("init", {
      meeting: {
        guildId: "guild",
        meetingId: "meeting",
        channelId: "channel",
        channelName: "Meeting",
        startedAt: "2026-01-01T00:00:00Z",
        isAutoRecording: false,
        status: "in_progress",
        attendees: [],
      },
      events: [voice],
    }),
  );
  act(() =>
    source.emit("events", {
      events: [{ ...voice, text: "The corrected words" }],
    }),
  );
  expect(result.current.events).toHaveLength(1);
  expect(result.current.events[0].text).toBe("The corrected words");
  act(() =>
    source.emit("events", { events: [], removedEventIds: ["voice-1"] }),
  );
  expect(result.current.events).toEqual([]);
});

it("retains untouched object identities while inserting late events by numeric offset", () => {
  const { result } = renderHook(() =>
    useLiveMeetingStream({
      guildId: "guild",
      meetingId: "meeting",
      enabled: true,
    }),
  );
  const source = TestEventSource.latest;
  const voice = {
    id: "voice-late",
    type: "voice",
    time: "1:40",
    offsetSeconds: 100,
    speaker: "Alice",
    text: "late words",
  };
  act(() => source.emit("events", { events: [voice] }));
  const retained = result.current.events[0];
  act(() =>
    source.emit("events", {
      events: [
        {
          ...voice,
          id: "voice-early",
          time: "0:09",
          offsetSeconds: 9,
          text: "earlier words",
        },
      ],
    }),
  );
  expect(result.current.events.map((event) => event.id)).toEqual([
    "voice-early",
    "voice-late",
  ]);
  expect(result.current.events[1]).toBe(retained);
  const early = result.current.events[0];
  act(() =>
    source.emit("events", { events: [], removedEventIds: ["voice-late"] }),
  );
  expect(result.current.events).toEqual([early]);
  expect(result.current.events[0]).toBe(early);
});

test("liveOwnerMissingDoesNotRenderComplete and status can be rechecked", () => {
  const hook = renderHook(() =>
    useLiveMeetingStream({ guildId: "g", meetingId: "m", enabled: true }),
  );
  const source = TestEventSource.latest;
  act(() =>
    source.emit("init", {
      meeting: {
        guildId: "g",
        meetingId: "m",
        channelId: "c",
        channelName: "Generated",
        startedAt: "2026-01-01T00:00:00Z",
        status: "unavailable",
        attendees: [],
      },
      events: [],
    }),
  );
  expect(hook.result.current.status).toBe("unavailable");
  expect(hook.result.current.meeting).not.toHaveProperty("endedAt");
  expect(source.close).toHaveBeenCalled();
  act(() => source.onerror?.());
  expect(hook.result.current.status).toBe("unavailable");
  act(() => hook.result.current.retry());
  act(() =>
    TestEventSource.latest.emit("init", {
      meeting: {
        guildId: "g",
        meetingId: "m",
        channelId: "c",
        channelName: "Generated",
        startedAt: "2026-01-01T00:00:00Z",
        status: "in_progress",
        attendees: [],
      },
      events: [],
    }),
  );
  expect(hook.result.current.status).toBe("live");
});

test("known interrupted and failed recordings stop the live state", () => {
  expect(toStreamStatus("interrupted")).toBe("interrupted");
  expect(toStreamStatus("failed")).toBe("failed");
  expect(toStreamStatus("starting")).toBe("starting");
  expect(toStreamStatus("complete")).toBe("complete");
});
