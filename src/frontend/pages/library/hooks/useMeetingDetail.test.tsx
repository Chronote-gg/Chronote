import { act, renderHook } from "@testing-library/react";
import { useMeetingDetail } from "./useMeetingDetail";
import type { MeetingDetailInput } from "../../../utils/meetingLibrary";
jest.mock("../../../services/apiClient", () => ({
  buildApiUrl: (path: string) => path,
}));
const mockInvalidate = jest.fn(async () => {});
const mockListInvalidate = jest.fn(async () => {});
let mockDetail: MeetingDetailInput;
const mockDetailUtils = { invalidate: mockInvalidate };
jest.mock("../../../services/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { detail: mockDetailUtils } }),
    meetings: {
      detail: {
        useQuery: () => ({
          data: { meeting: mockDetail },
          isLoading: false,
          isFetching: false,
          error: null,
        }),
      },
    },
  },
}));
const sources: FixtureSource[] = [];
class FixtureSource extends EventTarget {
  onerror: (() => void) | null = null;
  close = jest.fn();
  constructor() {
    super();
    sources.push(this);
  }
  init(status: string) {
    this.dispatchEvent(
      new MessageEvent("init", {
        data: JSON.stringify({
          meeting: {
            guildId: "generated",
            meetingId: "generated",
            channelId: "generated",
            channelName: "Generated",
            startedAt: "2026-01-01T00:00:00Z",
            status,
            isAutoRecording: false,
            attendees: [],
          },
          events: [],
        }),
      }),
    );
  }
  status(status: string) {
    this.dispatchEvent(
      new MessageEvent("status", { data: JSON.stringify({ status }) }),
    );
  }
}
beforeEach(() => {
  sources.length = 0;
  jest.clearAllMocks();
  Object.defineProperty(globalThis, "EventSource", {
    value: FixtureSource,
    configurable: true,
  });
  mockDetail = {
    id: "generated#2026-01-01",
    meetingId: "generated",
    channelId: "generated",
    timestamp: "2026-01-01T00:00:00Z",
    duration: 0,
    notes: "",
    status: "in_progress",
    transcriptAccessEnabled: true,
    events: [],
    attendees: [],
  };
});
test("unavailable SSE survives unchanged in-progress history and explicit returning-owner recheck", () => {
  const params = {
    selectedGuildId: "generated",
    selectedMeetingId: mockDetail.id,
    channelNameMap: new Map<string, string>(),
    invalidateMeetingLists: mockListInvalidate,
  };
  const hook = renderHook(() => useMeetingDetail(params));
  act(() => sources[0].init("in_progress"));
  expect(hook.result.current.displayStatus).toBe("in_progress");
  act(() => sources[0].status("unavailable"));
  expect(sources[0].close).toHaveBeenCalled();
  expect(mockInvalidate).toHaveBeenCalledTimes(1);
  expect(mockListInvalidate).toHaveBeenCalledTimes(1);
  mockDetail = { ...mockDetail };
  hook.rerender();
  expect(hook.result.current.meeting?.status).toBe("in_progress");
  expect(hook.result.current.detail?.status).toBe("in_progress");
  expect(hook.result.current.displayStatus).toBe("unavailable");
  expect(hook.result.current.timelineEmptyLabel).not.toMatch(
    /Waiting|will appear/,
  );
  act(() => hook.result.current.liveStream.retry());
  act(() => sources[1].init("in_progress"));
  expect(hook.result.current.displayStatus).toBe("in_progress");
  expect(hook.result.current.liveStream.status).toBe("live");
  expect(hook.result.current.meeting?.status).toBe("in_progress");
  act(() => sources[1].status("interrupted"));
  expect(mockInvalidate).toHaveBeenCalledTimes(2);
  expect(mockListInvalidate).toHaveBeenCalledTimes(2);
});
test("terminal canonical readback overrides old unavailable display and keeps transcript policy", () => {
  const hook = renderHook(() =>
    useMeetingDetail({
      selectedGuildId: "generated",
      selectedMeetingId: mockDetail.id,
      channelNameMap: new Map<string, string>(),
      invalidateMeetingLists: mockListInvalidate,
    }),
  );
  act(() => sources[0].init("unavailable"));
  mockDetail = {
    ...mockDetail,
    status: "interrupted",
    transcriptAccessEnabled: false,
  };
  hook.rerender();
  expect(hook.result.current.liveStreamEnabled).toBe(false);
  expect(hook.result.current.displayStatus).toBe("interrupted");
  expect(hook.result.current.meeting?.transcriptAccessEnabled).toBe(false);
});
