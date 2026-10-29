jest.mock("../../services/trpc", () => ({
  trpc: { notion: { automationStatus: { useQuery: () => ({}) } } },
}));
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import UnifiedMeetingsPage from "../UnifiedMeetingsPage";
import { meetingBrowseSearchSchema } from "../../utils/meetingBrowseSearch";
const mockNavigate = jest.fn();
let mockSearch = meetingBrowseSearchSchema.parse({});
import type { MeetingListItem } from "../library/types";
import type { MeetingSource } from "../../components/MeetingSources";
let mockBrowse: {
  items: MeetingListItem[];
  rows: MeetingListItem[];
  sources: MeetingSource[];
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  hasMore: boolean;
  discoveryComplete: boolean;
  loadMore: () => void;
  refresh: () => void;
} = {
  items: [],
  rows: [],
  sources: [],
  isLoading: false,
  isFetching: false,
  error: null,
  hasMore: false,
  discoveryComplete: true,
  loadMore: jest.fn(),
  refresh: jest.fn(),
};
jest.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => mockSearch,
}));
jest.mock("../../contexts/MeetingBrowseContext", () => ({
  useMeetingBrowseContext: () => mockBrowse,
}));
jest.mock("../../contexts/GuildContext", () => ({
  useGuildContext: () => ({ guilds: [] }),
}));
jest.mock("../../hooks/useInvalidateMeetingLists", () => ({
  useInvalidateMeetingLists: () => jest.fn(),
}));
jest.mock("../library/components/MeetingDetailDrawer", () => ({
  __esModule: true,
  default: ({
    selectedMeetingId,
    selectedGuildId,
    onClose,
    onFullScreenChange,
  }: {
    selectedMeetingId: string;
    selectedGuildId: string;
    onClose: () => void;
    onFullScreenChange: (value: boolean) => void;
  }) => (
    <div
      data-testid="drawer"
      data-server={selectedGuildId}
      data-meeting={selectedMeetingId}
    >
      <button onClick={onClose}>Close drawer</button>
      <button onClick={() => onFullScreenChange(true)}>Fullscreen</button>
    </div>
  ),
}));
const show = () =>
  render(
    <MantineProvider>
      <UnifiedMeetingsPage />
    </MantineProvider>,
  );
beforeEach(() => {
  mockSearch = meetingBrowseSearchSchema.parse({});
  jest.clearAllMocks();
  mockBrowse = {
    ...mockBrowse,
    items: [],
    rows: [],
    sources: [],
    isLoading: false,
    error: null,
    hasMore: false,
    discoveryComplete: true,
  };
});
test("attendance defaults unchecked and complete All empty offers upload", () => {
  show();
  expect(
    screen.getByRole("checkbox", { name: "Only meetings I attended" }),
  ).not.toBeChecked();
  expect(
    screen.getByText("Choose a source or upload your first recording."),
  ).toBeInTheDocument();
});
test.each([
  { isLoading: true },
  { discoveryComplete: false },
  { hasMore: true, discoveryComplete: false },
])(
  "does not show first-meeting guidance before discovery completes: %j",
  (state) => {
    mockBrowse = { ...mockBrowse, ...state };
    show();
    expect(
      screen.queryByText("Choose a source or upload your first recording."),
    ).not.toBeInTheDocument();
  },
);
test("personal empty offers the existing upload flow", () => {
  mockSearch = meetingBrowseSearchSchema.parse({ scope: "personal" });
  show();
  expect(
    screen.getByText("Upload your first personal recording."),
  ).toBeInTheDocument();
});
test("filtered empty clears filters without switching the source", () => {
  mockSearch = meetingBrowseSearchSchema.parse({
    scope: "personal",
    attended: true,
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(mockNavigate).toHaveBeenCalledWith(
    expect.objectContaining({
      search: expect.objectContaining({ scope: "personal", attended: false }),
    }),
  );
});

function row(id: string, serverId: string): MeetingListItem {
  return {
    id,
    meetingId: id,
    serverId,
    serverName: serverId,
    channelId: id,
    channelName: "Voice",
    timestamp: "2026-01-01T00:00:00Z",
    duration: 60,
    tags: ["tag"],
    notes: "",
    audioAvailable: true,
    transcriptAvailable: true,
    title: id,
    summary: "Summary",
    dateLabel: "Jan 1",
    durationLabel: "1m",
    channelLabel: "Voice",
  };
}
test("mixed guild, owned personal and shared personal rows use the row's exact drawer pair", () => {
  mockBrowse.items = [
    row("guild-row", "guild"),
    row("owned", "personal:me"),
    row("shared", "personal:other"),
  ];
  mockBrowse.rows = mockBrowse.items;
  show();
  expect(screen.getAllByTestId("library-meeting-row")).toHaveLength(3);
  fireEvent.click(screen.getAllByTestId("library-meeting-row")[2]);
  expect(mockNavigate).toHaveBeenCalledWith(
    expect.objectContaining({
      search: expect.objectContaining({
        scope: "all",
        meetingServerId: "personal:other",
        meetingId: "shared",
      }),
    }),
  );
});
test("source selection clears source-local filters and drawer, preserving date/archive", () => {
  mockSearch = meetingBrowseSearchSchema.parse({
    attended: true,
    q: "query",
    tags: "tag",
    channelId: "channel",
    range: "7",
    archive: "all",
    meetingServerId: "guild",
    meetingId: "record",
  });
  mockBrowse.sources = [{ id: "guild", name: "Server" }];
  show();
  fireEvent.click(screen.getByRole("button", { name: /Personal recordings/ }));
  expect(mockNavigate).toHaveBeenCalledWith({
    search: { scope: "personal", attended: false, range: "7", archive: "all" },
  });
});
test("URL history updates restore selection and closing/fullscreen preserves the list filters", () => {
  mockSearch = meetingBrowseSearchSchema.parse({
    scope: "personal",
    q: "loaded",
    range: "7",
    meetingServerId: "personal:other",
    meetingId: "record",
  });
  const view = show();
  expect(screen.getByTestId("drawer")).toHaveAttribute(
    "data-server",
    "personal:other",
  );
  fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
  expect(mockNavigate).toHaveBeenLastCalledWith({
    search: expect.objectContaining({
      q: "loaded",
      scope: "personal",
      fullScreen: true,
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
  expect(mockNavigate).toHaveBeenLastCalledWith({
    search: expect.objectContaining({
      q: "loaded",
      scope: "personal",
      range: "7",
    }),
  });
  expect(mockNavigate.mock.lastCall[0].search.meetingId).toBeUndefined();
  mockSearch = meetingBrowseSearchSchema.parse({
    scope: "guild",
    serverId: "next",
  });
  view.rerender(
    <MantineProvider>
      <UnifiedMeetingsPage />
    </MantineProvider>,
  );
  expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
  mockSearch = meetingBrowseSearchSchema.parse({
    scope: "personal",
    meetingServerId: "personal:other",
    meetingId: "record",
  });
  view.rerender(
    <MantineProvider>
      <UnifiedMeetingsPage />
    </MantineProvider>,
  );
  expect(screen.getByTestId("drawer")).toHaveAttribute(
    "data-meeting",
    "record",
  );
});
test("complete server empty uses server copy without granting manager setup", () => {
  mockSearch = meetingBrowseSearchSchema.parse({
    scope: "guild",
    serverId: "previous",
  });
  mockBrowse.sources = [
    { id: "previous", name: "Previous Server", retainedAccess: true },
  ];
  show();
  expect(
    screen.getByText("Your first meeting in Previous Server goes here."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Read about optional setup"),
  ).not.toBeInTheDocument();
});
test("permission errors never become successful empty onboarding", () => {
  mockBrowse.error = new Error("Forbidden");
  show();
  expect(
    screen.getByText("Unable to load meetings. Try again shortly."),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("Choose a source or upload your first recording."),
  ).not.toBeInTheDocument();
});
test("a missing membership source retains authorized rows without onboarding", () => {
  mockSearch = meetingBrowseSearchSchema.parse({
    scope: "guild",
    serverId: "previous",
  });
  mockBrowse.items = [row("authorized-row", "previous")];
  mockBrowse.rows = mockBrowse.items;
  show();
  expect(screen.getByText("authorized-row")).toBeInTheDocument();
  expect(
    screen.queryByTestId("first-meeting-empty-state"),
  ).not.toBeInTheDocument();
});
