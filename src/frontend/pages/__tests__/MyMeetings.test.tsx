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
