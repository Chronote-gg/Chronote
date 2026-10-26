import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MyMeetings from "../MyMeetings";

const mockNavigate = jest.fn();
const mockMyListUseQuery = jest.fn();
const mockUseGuildContext = jest.fn();

jest.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock("../../contexts/GuildContext", () => ({
  useGuildContext: () => mockUseGuildContext(),
}));

jest.mock("../../services/trpc", () => ({
  trpc: {
    meetings: {
      myList: { useQuery: (...args: unknown[]) => mockMyListUseQuery(...args) },
    },
  },
}));

const renderPage = () =>
  render(
    <MantineProvider>
      <MyMeetings />
    </MantineProvider>,
  );

describe("MyMeetings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseGuildContext.mockReturnValue({
      guilds: [{ id: "guild-1", name: "Server One", canManage: true }],
    });
    mockMyListUseQuery.mockReturnValue({
      data: {
        meetings: [
          {
            id: "channel-1#2026-01-02T00:00:00.000Z",
            meetingId: "meeting-1",
            serverId: "guild-1",
            serverName: "Server One",
            channelId: "channel-1",
            channelName: "General",
            timestamp: "2026-01-02T00:00:00.000Z",
            duration: 3600,
            tags: ["planning"],
            meetingName: "Weekly planning",
            summarySentence: "Planned the week across teams.",
            audioAvailable: true,
            transcriptAvailable: true,
            notesAvailable: true,
          },
        ],
        hasMore: false,
        nextCursor: null,
      },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it.each(["disabled", "no_usable_speech"] as const)(
    "keeps unknown interrupted duration and truthful terminal %s copy",
    async (outcome) => {
      mockMyListUseQuery.mockReturnValue({
        data: {
          meetings: [
            {
              id: "generated#2026-01-01",
              meetingId: "generated",
              serverId: "guild-1",
              serverName: "Server One",
              channelId: "generated",
              channelName: "Generated",
              timestamp: "2026-01-01T00:00:00Z",
              duration: 0,
              tags: [],
              meetingName: "Generated recovery",
              status: "interrupted",
              audioAvailable: false,
              transcriptAvailable: false,
              notesAvailable: false,
              recoveryNotice:
                outcome === "disabled"
                  ? "Recovery finished with the original transcription and notes settings."
                  : "No usable saved speech was found.",
              capture: {
                kind: "interrupted",
                startedAt: "2026-01-01T00:00:00Z",
                detectedAt: "2026-01-01T00:30:00Z",
                endedAt: null,
              },
              recovery: { disposition: "done", stage: "notes", outcome },
            },
          ],
          hasMore: false,
          nextCursor: null,
        },
        isLoading: false,
        isFetching: false,
        error: null,
        refetch: jest.fn(),
      });
      renderPage();
      expect(
        await screen.findByText("Unknown duration", { exact: false }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Notes will appear after the meeting is processed."),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("1m", { exact: true })).not.toBeInTheDocument();
      expect(screen.getByText("No summary available.")).toBeInTheDocument();
      expect(screen.queryByText("No summary yet.")).not.toBeInTheDocument();
      expect(
        screen.getByText(
          outcome === "disabled"
            ? "Recovery finished with the original transcription and notes settings."
            : "No usable saved speech was found.",
        ),
      ).toBeInTheDocument();
    },
  );
  it("lists cross-server meetings with server context", async () => {
    renderPage();

    expect(screen.getByTestId("my-meetings-page")).toBeInTheDocument();
    expect(await screen.findByText("Weekly planning")).toBeInTheDocument();
    expect(screen.getAllByText("Server One")).not.toHaveLength(0);
    expect(mockMyListUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "attended",
        range: "all",
        limit: 25,
        archivedOnly: undefined,
        tags: undefined,
      }),
    );
  });

  it("opens the direct meeting detail route", async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId("library-meeting-row"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/portal/meetings/$serverId/$meetingId",
      params: {
        serverId: "guild-1",
        meetingId: "channel-1#2026-01-02T00:00:00.000Z",
      },
    });
  });

  it("offers server selection from the empty state", () => {
    mockMyListUseQuery.mockReturnValue({
      data: { meetings: [], hasMore: false, nextCursor: null },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: jest.fn(),
    });

    renderPage();

    expect(screen.getByText("No meetings found here yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("my-meetings-view-servers"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/portal/select-server",
    });
  });

  it("opens the personal upload route", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("my-meetings-upload"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/portal/upload",
    });
  });

  it("keeps personal Notion automation out of the meeting list page", () => {
    renderPage();

    expect(
      screen.queryByText(
        "Export personal meeting notes to your Notion page destination.",
      ),
    ).not.toBeInTheDocument();
  });

  it("loads the next My Meetings page with the returned cursor", async () => {
    const firstPage = {
      meetings: [
        {
          id: "channel-1#2026-01-02T00:00:00.000Z",
          meetingId: "meeting-1",
          serverId: "guild-1",
          serverName: "Server One",
          channelId: "channel-1",
          channelName: "General",
          timestamp: "2026-01-02T00:00:00.000Z",
          duration: 3600,
          tags: ["planning"],
          meetingName: "Weekly planning",
          summarySentence: "Planned the week across teams.",
          audioAvailable: true,
          transcriptAvailable: true,
          notesAvailable: true,
        },
      ],
      hasMore: true,
      nextCursor: "cursor-page-2",
    };
    const secondPage = {
      meetings: [
        {
          id: "channel-1#2026-01-01T00:00:00.000Z",
          meetingId: "meeting-2",
          serverId: "guild-1",
          serverName: "Server One",
          channelId: "channel-1",
          channelName: "General",
          timestamp: "2026-01-01T00:00:00.000Z",
          duration: 1800,
          tags: [],
          meetingName: "Older planning",
          summarySentence: "Reviewed older notes.",
          audioAvailable: false,
          transcriptAvailable: true,
          notesAvailable: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
    mockMyListUseQuery.mockImplementation((input) => ({
      data: input?.cursor ? secondPage : firstPage,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: jest.fn(),
    }));

    renderPage();

    expect(await screen.findByText("Weekly planning")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("my-meetings-load-more"));

    expect(await screen.findByText("Older planning")).toBeInTheDocument();
    expect(mockMyListUseQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-page-2" }),
    );
  });

  it("retries a failed Load more request with the same cursor", async () => {
    const retryRefetch = jest.fn();
    const firstPage = {
      meetings: [
        {
          id: "channel-1#2026-01-02T00:00:00.000Z",
          meetingId: "meeting-1",
          serverId: "guild-1",
          serverName: "Server One",
          channelId: "channel-1",
          channelName: "General",
          timestamp: "2026-01-02T00:00:00.000Z",
          duration: 3600,
          tags: ["planning"],
          meetingName: "Weekly planning",
          summarySentence: "Planned the week across teams.",
          audioAvailable: true,
          transcriptAvailable: true,
          notesAvailable: true,
        },
      ],
      hasMore: true,
      nextCursor: "cursor-page-2",
    };
    mockMyListUseQuery.mockImplementation((input) => ({
      data: input?.cursor ? undefined : firstPage,
      isLoading: false,
      isFetching: false,
      error: input?.cursor ? new Error("Failed to load page") : null,
      refetch: retryRefetch,
    }));

    renderPage();

    expect(await screen.findByText("Weekly planning")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("my-meetings-load-more"));

    await waitFor(() =>
      expect(mockMyListUseQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: "cursor-page-2" }),
      ),
    );
    fireEvent.click(await screen.findByTestId("my-meetings-load-more"));

    expect(retryRefetch).toHaveBeenCalledTimes(1);
  });

  it("shows loading instead of empty state while refreshing", async () => {
    let isRefreshing = false;
    const refreshRefetch = jest.fn(() => {
      isRefreshing = true;
    });
    const firstPage = {
      meetings: [
        {
          id: "channel-1#2026-01-02T00:00:00.000Z",
          meetingId: "meeting-1",
          serverId: "guild-1",
          serverName: "Server One",
          channelId: "channel-1",
          channelName: "General",
          timestamp: "2026-01-02T00:00:00.000Z",
          duration: 3600,
          tags: ["planning"],
          meetingName: "Weekly planning",
          summarySentence: "Planned the week across teams.",
          audioAvailable: true,
          transcriptAvailable: true,
          notesAvailable: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
    mockMyListUseQuery.mockImplementation(() => ({
      data: isRefreshing ? undefined : firstPage,
      isLoading: false,
      isFetching: isRefreshing,
      error: null,
      refetch: refreshRefetch,
    }));

    renderPage();

    expect(await screen.findByText("Weekly planning")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("my-meetings-refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("library-loading")).toBeInTheDocument(),
    );
    expect(screen.queryByText("No meetings found here yet.")).toBeNull();
  });
});
