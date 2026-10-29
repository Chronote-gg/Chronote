import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { meetingBrowseSearchSchema } from "../../utils/meetingBrowseSearch";
import { useMeetingBrowse } from "./useMeetingBrowse";
const mockFetch = jest.fn();
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ protectedQueriesReady: true }),
}));
jest.mock("../../services/trpc", () => ({
  trpc: {
    meetings: {
      myList: {
        useInfiniteQuery: (input: Record<string, unknown>, options: object) =>
          useInfiniteQuery({
            queryKey: [input],
            queryFn: ({ pageParam }) =>
              mockFetch({ ...input, cursor: pageParam }),
            initialPageParam: undefined,
            getNextPageParam: () => undefined,
            ...options,
          }),
      },
    },
  },
}));
const emptyBrowsePage = () => ({
  meetings: [],
  hasMore: false,
  discoveryComplete: true,
});

function createBrowseHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

test("source changes exclude a delayed previous-source response and use explicit defaults", async () => {
  let finishOld: (value: unknown) => void = () => {};
  mockFetch
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue({
      meetings: [],
      hasMore: false,
      discoveryComplete: true,
    });
  const { client, wrapper } = createBrowseHarness();
  const { result, rerender } = renderHook(
    ({ search }) => useMeetingBrowse(search),
    { wrapper, initialProps: { search: meetingBrowseSearchSchema.parse({}) } },
  );
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  expect(mockFetch.mock.calls[0][0]).toMatchObject({
    mode: "accessible",
    range: "all",
    limit: 25,
    browse: { scope: { kind: "all" }, attendedOnly: false },
  });
  rerender({ search: meetingBrowseSearchSchema.parse({ scope: "personal" }) });
  await waitFor(() => expect(result.current.discoveryComplete).toBe(true));
  await act(async () => {
    finishOld({
      meetings: [{ id: "private-old-source" }],
      discoveryComplete: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(result.current.items).toEqual([]));
  client.clear();
});

beforeEach(() => mockFetch.mockReset());
test.each([
  { attended: true },
  { range: "7" },
  { range: "90" },
  { archive: "archived" },
  { tags: "planning" },
  { channelId: "voice" },
  {
    range: "custom",
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-02-01T00:00:00Z",
  },
])("server filter changes reset pagination: %j", async (patch) => {
  mockFetch.mockResolvedValue({
    meetings: [],
    hasMore: true,
    nextCursor: "page-2",
    discoveryComplete: false,
  });
  const { client, wrapper } = createBrowseHarness();
  const { result, rerender } = renderHook(
    ({ search }) => useMeetingBrowse(search),
    { wrapper, initialProps: { search: meetingBrowseSearchSchema.parse({}) } },
  );
  await waitFor(() => expect(result.current.hasMore).toBe(true));
  await act(async () => result.current.loadMore());
  await waitFor(() =>
    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "page-2" }),
    ),
  );
  rerender({ search: meetingBrowseSearchSchema.parse(patch) });
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
  expect(mockFetch.mock.lastCall[0].cursor).toBeUndefined();
  expect(result.current.discoveryComplete).toBe(false);
  expect(result.current.items).toEqual([]);
  client.clear();
});

test("retry after a denied refetch reauthorizes the first page before showing retained rows", async () => {
  const oldRow = {
    id: "old",
    meetingId: "old",
    serverId: "guild",
    channelId: "voice",
    channelName: "Voice",
    timestamp: "2026-01-01T00:00:00Z",
    duration: 60,
    tags: [],
    audioAvailable: false,
    transcriptAvailable: false,
  };
  mockFetch.mockResolvedValue({
    meetings: [oldRow],
    hasMore: true,
    nextCursor: "next",
    discoveryComplete: false,
  });
  const { client, wrapper } = createBrowseHarness();
  const { result } = renderHook(
    () => useMeetingBrowse(meetingBrowseSearchSchema.parse({})),
    { wrapper },
  );
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  mockFetch.mockRejectedValueOnce(new Error("Forbidden"));
  await act(async () => {
    await result.current.refresh();
  });
  await waitFor(() => expect(result.current.items).toEqual([]));
  mockFetch.mockResolvedValue(emptyBrowsePage());
  await act(async () => result.current.loadMore());
  await waitFor(() => expect(result.current.discoveryComplete).toBe(true));
  expect(mockFetch.mock.lastCall[0].cursor).toBeUndefined();
  expect(result.current.items).toEqual([]);
  client.clear();
});

test("90 days requests the exact rolling custom range", async () => {
  mockFetch.mockResolvedValue(emptyBrowsePage());
  const { client, wrapper } = createBrowseHarness();
  const { result } = renderHook(
    () => useMeetingBrowse(meetingBrowseSearchSchema.parse({ range: "90" })),
    { wrapper },
  );
  await waitFor(() => expect(result.current.discoveryComplete).toBe(true));
  const input = mockFetch.mock.lastCall[0];
  expect(input.range).toBe("custom");
  expect(Date.parse(input.endDate) - Date.parse(input.startDate)).toBe(
    90 * 86400000,
  );
  client.clear();
});
test("an incomplete custom range pauses queries and explicit refresh until both endpoints exist", async () => {
  mockFetch.mockResolvedValue(emptyBrowsePage());
  const { client, wrapper } = createBrowseHarness();
  const { result } = renderHook(
    () =>
      useMeetingBrowse(
        meetingBrowseSearchSchema.parse({
          range: "custom",
          startDate: "2026-10-01T13:00:00.000Z",
        }),
      ),
    { wrapper },
  );
  await act(async () => {
    await result.current.refresh();
    result.current.loadMore();
  });
  expect(mockFetch).not.toHaveBeenCalled();
  expect(result.current.items).toEqual([]);
  expect(result.current.discoveryComplete).toBe(false);
  expect(result.current.isLoading).toBe(false);
  client.clear();
});
