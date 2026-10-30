import { act, renderHook } from "@testing-library/react";
import { useMeetingDetail } from "./useMeetingDetail";
import type { MeetingDetailInput } from "../../../utils/meetingLibrary";
jest.mock("../../../services/apiClient", () => ({
  buildApiUrl: (path: string) => path,
}));
const mockInvalidate = jest.fn(async () => {});
const mockListInvalidate = jest.fn(async () => {});
const mockRefetch = jest.fn();
let mockFetching = false;
let mockQueryError: unknown = null;
let mockDetail: MeetingDetailInput;
const mockDetailUtils = { invalidate: mockInvalidate };
const mockRetryMutate = jest.fn();
type RefetchInterval = (query: {
  queryHash: string;
  state: { data?: { meeting?: MeetingDetailInput }; dataUpdateCount: number };
}) => number | false;
let mockQueryOptions: { refetchInterval: RefetchInterval };
let mockRetryOptions: { onSettled: () => Promise<unknown> };
jest.mock("../../../services/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { detail: mockDetailUtils } }),
    meetings: {
      detail: {
        useQuery: (
          _input: unknown,
          options: { refetchInterval: RefetchInterval },
        ) => {
          mockQueryOptions = options;
          return {
            data: { meeting: mockDetail },
            isLoading: false,
            isFetching: mockFetching,
            error: mockQueryError,
            refetch: mockRefetch,
          };
        },
      },
      retryProcessing: {
        useMutation: (options: { onSettled: () => Promise<unknown> }) => {
          mockRetryOptions = options;
          return { isPending: false, mutate: mockRetryMutate };
        },
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
  mockRefetch.mockResolvedValue({});
  mockFetching = false;
  mockQueryError = null;
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
    opened: true,
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
      opened: true,
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

const retryView = {
  eligible: true,
  requiresReplaceConfirm: true,
  attemptsRemaining: 3,
};
const renderRetryDetail = () => {
  mockDetail = {
    ...mockDetail,
    status: "complete",
    processingRetry: retryView,
  };
  return renderHook(() =>
    useMeetingDetail({
      opened: true,
      selectedGuildId: "generated",
      selectedMeetingId: mockDetail.id,
      channelNameMap: new Map<string, string>(),
      invalidateMeetingLists: mockListInvalidate,
    }),
  );
};
const retryIntervalFor = (
  status?: "queued" | "running" | "failed",
  dataUpdateCount = 1,
) =>
  mockQueryOptions.refetchInterval({
    queryHash: "detail-generated",
    state: {
      dataUpdateCount,
      data: {
        meeting: { ...mockDetail, processingRetry: { ...retryView, status } },
      },
    },
  });

test("polls while a processing retry is active and wires the retry action", async () => {
  const hook = renderRetryDetail();
  expect(hook.result.current.processingRetry?.view).toBe(retryView);
  hook.result.current.processingRetry?.onRetry(true);
  expect(mockRetryMutate).toHaveBeenCalledWith({
    serverId: "generated",
    meetingId: mockDetail.id,
    replaceNotes: true,
  });
  expect(retryIntervalFor("queued")).toBe(5000);
  expect(retryIntervalFor("running")).toBe(5000);
  expect(retryIntervalFor("failed")).toBe(false);
  expect(retryIntervalFor()).toBe(false);
  await mockRetryOptions.onSettled();
  expect(mockInvalidate).toHaveBeenCalledTimes(1);
  expect(mockListInvalidate).toHaveBeenCalledTimes(1);
});

test("stops polling an active retry after the bounded read budget", () => {
  renderRetryDetail();
  expect(retryIntervalFor("queued", 10)).toBe(5000);
  expect(retryIntervalFor("running", 69)).toBe(5000);
  expect(retryIntervalFor("running", 70)).toBe(false);
  expect(retryIntervalFor("running", 75)).toBe(false);
  expect(retryIntervalFor("failed", 76)).toBe(false);
  expect(retryIntervalFor("queued", 77)).toBe(5000);
});

describe("completed delivery refresh", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDetail = {
      ...mockDetail,
      status: "complete",
      notes: "Saved canonical notes",
      updateDelivery: {
        status: "pending",
        reason: null,
        pollable: true,
        desiredRevision: 2,
        syncedRevision: null,
        lastSuccess: null,
      },
    };
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const params = () => ({
    opened: true,
    selectedGuildId: "generated",
    selectedMeetingId: mockDetail.id,
    channelNameMap: new Map<string, string>(),
    invalidateMeetingLists: mockListInvalidate,
  });
  test("background fetching and failure keep canonical content visible", () => {
    mockFetching = true;
    mockQueryError = new Error("Synthetic status read failed");
    const hook = renderHook(() => useMeetingDetail(params()));
    expect(hook.result.current.detailLoading).toBe(false);
    expect(hook.result.current.detailError).toBeNull();
    expect(hook.result.current.meeting?.notes).toBe("Saved canonical notes");
  });
  test("a pending acknowledgment starts refresh before stale detail catches up", async () => {
    const acknowledgedDelivery = mockDetail.updateDelivery;
    mockDetail = {
      ...mockDetail,
      updateDelivery: {
        status: "unpublished",
        reason: null,
        pollable: false,
        desiredRevision: 1,
        syncedRevision: null,
        lastSuccess: null,
      },
    };
    renderHook(() => useMeetingDetail({ ...params(), acknowledgedDelivery }));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
  test.each([
    { status: "held", reason: "explicit_hold", pollable: false },
    { status: "blocked", reason: "retry_exhausted", pollable: false },
    {
      status: "uncertain",
      reason: "provider_outcome_unknown",
      pollable: false,
    },
    { status: "unpublished", reason: null, pollable: false },
  ] as const)("stops on terminal $status", async (state) => {
    const hook = renderHook(() => useMeetingDetail(params()));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    mockDetail = {
      ...mockDetail,
      updateDelivery: {
        ...state,
        desiredRevision: 2,
        syncedRevision: null,
        lastSuccess: null,
      },
    };
    hook.rerender();
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
  test("a higher acknowledged revision restarts a bounded budget with stable refetch", async () => {
    const pending = mockDetail.updateDelivery;
    if (!pending) throw new Error("Pending delivery fixture required");
    const acknowledgment: Pick<
      Parameters<typeof useMeetingDetail>[0],
      "acknowledgedDelivery"
    > = {};
    const selection = params();
    const hook = renderHook(() =>
      useMeetingDetail({ ...selection, ...acknowledgment }),
    );
    // mockRefetch is the same function throughout, including every new data object.
    const read = async () => {
      mockDetail = {
        ...mockDetail,
        updateDelivery: { ...(mockDetail.updateDelivery ?? pending) },
      };
      hook.rerender();
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
    };
    for (let i = 0; i < 61; i++) await read();
    expect(mockRefetch).toHaveBeenCalledTimes(60);

    acknowledgment.acknowledgedDelivery = {
      ...pending,
      desiredRevision: pending.desiredRevision + 1,
    };
    await read();
    expect(mockRefetch).toHaveBeenCalledTimes(61);
    expect(hook.result.current.meeting?.notes).toBe("Saved canonical notes");

    // Canonical readback catches the ACK without starting another episode.
    mockDetail = {
      ...mockDetail,
      updateDelivery: acknowledgment.acknowledgedDelivery,
    };
    for (let i = 0; i < 61; i++) await read();
    expect(mockRefetch).toHaveBeenCalledTimes(120);
    expect(hook.result.current.meeting?.notes).toBe("Saved canonical notes");
  });

  test("bounds an open pending selection to sixty completed reads", async () => {
    renderHook(() => useMeetingDetail(params()));
    for (let i = 0; i < 61; i++)
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
    expect(mockRefetch).toHaveBeenCalledTimes(60);
  });
  test("waits for an in-flight read and stops at synced without blanking canonical notes", async () => {
    let finish: (() => void) | undefined;
    mockRefetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(() => useMeetingDetail(params()));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(20000);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.meeting?.notes).toBe("Saved canonical notes");
    mockDetail = {
      ...mockDetail,
      updateDelivery: {
        status: "synced",
        reason: null,
        pollable: false,
        desiredRevision: 2,
        syncedRevision: 2,
        lastSuccess: { at: 1767225600, contentRevision: 2 },
      },
    };
    await act(async () => {
      finish?.();
    });
    hook.rerender();
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.meeting?.updateDelivery?.status).toBe("synced");
    expect(sources).toHaveLength(0);
  });
  test.each(["close", "deselect", "switch", "unmount"] as const)(
    "cleans up %s while an old read is deferred",
    async (action) => {
      let finish: (() => void) | undefined;
      mockRefetch.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const initial = params();
      const hook = renderHook((p) => useMeetingDetail(p), {
        initialProps: {
          ...initial,
          selectedMeetingId: initial.selectedMeetingId as string | null,
        },
      });
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockRefetch).toHaveBeenCalledTimes(1);
      if (action === "unmount") hook.unmount();
      else
        hook.rerender({
          ...initial,
          opened: action !== "close",
          selectedMeetingId:
            action === "deselect"
              ? null
              : action === "switch"
                ? "other-meeting"
                : initial.selectedMeetingId,
        });
      await act(async () => {
        finish?.();
      });
      await act(async () => {
        jest.advanceTimersByTime(20000);
      });
      expect(mockRefetch).toHaveBeenCalledTimes(1);
      if (action === "switch") expect(hook.result.current.meeting).toBeNull();
    },
  );
});

test("access denial on refetch clears sensitive canonical detail", () => {
  mockQueryError = { data: { code: "FORBIDDEN" } };
  const hook = renderHook(() =>
    useMeetingDetail({
      opened: true,
      selectedGuildId: "generated",
      selectedMeetingId: mockDetail.id,
      channelNameMap: new Map(),
      invalidateMeetingLists: mockListInvalidate,
    }),
  );
  expect(hook.result.current.detail).toBeNull();
  expect(hook.result.current.meeting).toBeNull();
});
test("a stale drawer response cannot populate another selected record", () => {
  const hook = renderHook(() =>
    useMeetingDetail({
      opened: true,
      selectedGuildId: "generated",
      selectedMeetingId: "different-record",
      channelNameMap: new Map(),
      invalidateMeetingLists: mockListInvalidate,
    }),
  );
  expect(hook.result.current.meeting).toBeNull();
});
