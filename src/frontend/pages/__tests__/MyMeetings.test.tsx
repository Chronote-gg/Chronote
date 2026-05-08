import { fireEvent, render, screen } from "@testing-library/react";
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
      },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it("lists cross-server meetings with server context", () => {
    renderPage();

    expect(screen.getByTestId("my-meetings-page")).toBeInTheDocument();
    expect(screen.getByText("Weekly planning")).toBeInTheDocument();
    expect(screen.getAllByText("Server One")).not.toHaveLength(0);
    expect(mockMyListUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "attended",
        range: "past_7_days",
        archivedOnly: undefined,
        tags: undefined,
      }),
    );
  });

  it("opens the existing server library detail route", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("library-meeting-row"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/portal/server/$serverId/library",
      params: { serverId: "guild-1" },
      search: { meetingId: "channel-1#2026-01-02T00:00:00.000Z" },
    });
  });
});
