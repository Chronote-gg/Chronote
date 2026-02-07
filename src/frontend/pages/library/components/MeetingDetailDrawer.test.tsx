import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import MeetingDetailDrawer from "./MeetingDetailDrawer";
import { useMeetingDetail } from "../hooks/useMeetingDetail";
import {
  type MeetingDetailInput,
  type MeetingDetails,
} from "../../../utils/meetingLibrary";
import { MEETING_STATUS } from "../../../../types/meetingLifecycle";

jest.mock("@tanstack/react-router", () => ({
  ...jest.requireActual("@tanstack/react-router"),
  useNavigate: () => jest.fn(),
  useSearch: () => ({ fullScreen: false }),
  useRouterState: (options?: {
    select?: (state: { matches: Array<{ routeId: string }> }) => unknown;
  }) => {
    const state = {
      matches: [{ routeId: "/portal/server/$serverId/library" }],
    };
    return options?.select ? options.select(state) : state;
  },
}));

jest.mock("../../../services/trpc", () => ({
  trpc: {
    useUtils: () => ({
      meetings: {
        detail: {
          invalidate: jest.fn(),
        },
      },
    }),
    meetings: {
      setArchived: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue(undefined),
          isPending: false,
          error: undefined,
        }),
      },
      rename: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue(undefined),
          isPending: false,
          error: undefined,
        }),
      },
      suggestNotesCorrection: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({
            token: "mock-token",
            diff: "+ mock diff",
            changed: true,
          }),
          isPending: false,
          error: undefined,
        }),
      },
      applyNotesCorrection: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({ ok: true }),
          isPending: false,
          error: undefined,
        }),
      },
    },
    feedback: {
      submitSummary: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue(undefined),
          isPending: false,
          error: undefined,
        }),
      },
    },
  },
}));

jest.mock("../hooks/useMeetingDetail", () => ({
  useMeetingDetail: jest.fn(),
}));

jest.mock("@mantine/notifications", () => ({
  notifications: {
    show: jest.fn(),
  },
}));

const useMeetingDetailMock = jest.mocked(useMeetingDetail);

const buildMeeting = (overrides?: Partial<MeetingDetails>): MeetingDetails => ({
  id: "m1",
  meetingId: "meeting-1",
  title: "Weekly sync",
  meetingName: undefined,
  summary: "Summary line",
  summaryLabel: undefined,
  summaryFeedback: null,
  notes: "- Decision: Ship it",
  dateLabel: "Jan 6, 2026",
  durationLabel: "45m",
  tags: [],
  channel: "#general",
  audioUrl: null,
  archivedAt: null,
  attendees: [],
  decisions: [],
  actions: [],
  events: [],
  status: MEETING_STATUS.COMPLETE,
  ...overrides,
});

const buildDetail = (
  overrides?: Partial<MeetingDetailInput>,
): MeetingDetailInput => ({
  id: "m1",
  meetingId: "meeting-1",
  channelId: "c1",
  timestamp: "2026-01-06T18:00:00.000Z",
  duration: 2700,
  tags: [],
  notes: "- Decision: Ship it",
  meetingName: null,
  summarySentence: null,
  summaryLabel: null,
  notesChannelId: null,
  notesMessageId: null,
  transcript: "",
  audioUrl: null,
  archivedAt: null,
  attendees: [],
  events: [],
  status: MEETING_STATUS.COMPLETE,
  ...overrides,
});

const buildUseMeetingDetailResult = (params?: {
  detail?: MeetingDetailInput | null;
  meeting?: MeetingDetails | null;
}): ReturnType<typeof useMeetingDetail> => ({
  detail: params?.detail ?? buildDetail(),
  meeting: params?.meeting ?? buildMeeting(),
  detailLoading: false,
  detailError: null,
  liveStreamEnabled: false,
  liveStream: {
    status: "connecting",
    attendees: [],
    events: [],
    meeting: null,
    retry: jest.fn(),
  },
  displayStatus: MEETING_STATUS.COMPLETE,
  displayAttendees: [],
  displayEvents: [],
  timelineEmptyLabel:
    "Timeline data will appear after the meeting finishes processing.",
});

const renderDrawer = () =>
  render(
    <MantineProvider>
      <MeetingDetailDrawer
        opened
        selectedMeetingId="m1"
        selectedGuildId="g1"
        canManageSelectedGuild
        channelNameMap={new Map([["c1", "general"]])}
        invalidateMeetingLists={jest.fn(async () => {})}
        onClose={jest.fn()}
      />
    </MantineProvider>,
  );

describe("MeetingDetailDrawer summary copy", () => {
  const writeTextMock = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    useMeetingDetailMock.mockReturnValue(buildUseMeetingDetailResult());
    writeTextMock.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: writeTextMock,
      },
      configurable: true,
    });
  });

  it("copies summary notes as Markdown", async () => {
    const notesMarkdown = "- Decision: Ship it\n- Action: Follow up";
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ notes: notesMarkdown }),
        meeting: buildMeeting({ notes: notesMarkdown }),
      }),
    );

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Copy summary as Markdown"));

    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith(notesMarkdown),
    );
    expect(notifications.show).toHaveBeenCalledWith({
      color: "green",
      message: "Summary copied to clipboard.",
    });
  });

  it("disables copy when no notes are available", () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ notes: "   " }),
      }),
    );

    renderDrawer();
    const copyButton = screen.getByLabelText("Copy summary as Markdown");
    expect(copyButton).toBeDisabled();
  });
});
