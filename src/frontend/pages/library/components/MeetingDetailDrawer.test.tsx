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

const mockShareStateQuery = {
  data: {
    meetingSharingPolicy: "server",
    state: { visibility: "private" },
  },
  isLoading: false,
  isFetching: false,
  error: null as unknown,
  refetch: jest.fn().mockResolvedValue(undefined),
};

const mockPersonalShareStateQuery = {
  data: {
    accessGrants: [
      { targetType: "user" as const, userId: "111111111111111111" },
    ],
  },
  isLoading: false,
  isFetching: false,
  error: null as unknown,
  refetch: jest.fn().mockResolvedValue(undefined),
};

const mockSetPersonalShareGrants = jest.fn().mockResolvedValue({
  accessGrants: [],
});

const mockSuggestNotesCorrection = jest.fn().mockResolvedValue({
  token: "mock-token",
  diff: "+ mock diff",
  changed: true,
});

const mockApplyNotesCorrection = jest.fn().mockResolvedValue({
  ok: true,
  dictionaryTeachingContextToken: "11111111-1111-4111-8111-111111111111",
  dictionaryTeachingContextExpiresAtMs: Date.now() + 15 * 60 * 1_000,
  dictionaryTeachingInstruction:
    "It wrote John Smith, but his name is Jon Smythe.",
});

const mockPreviewTeaching = jest.fn().mockResolvedValue({
  token: "22222222-2222-4222-8222-222222222222",
  expiresAtMs: Date.now() + 15 * 60 * 1_000,
  drafts: [],
});

const mockNotionStatusQuery = {
  data: { configured: true, connected: false },
  isLoading: false,
  isFetching: false,
  error: null,
};

const mockNotionExportStatusQuery: {
  data:
    | {
        exported: boolean;
        currentNotesVersion: number;
        outdated: boolean;
        source?: "manual" | "automation";
        lastError?: string;
      }
    | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
} = {
  data: { exported: false, currentNotesVersion: 1, outdated: false },
  isLoading: false,
  isFetching: false,
  error: null,
};

const mockNotionExportStatusUseQuery = jest.fn(
  () => mockNotionExportStatusQuery,
);

jest.mock("../../../services/trpc", () => ({
  trpc: {
    useUtils: () => ({
      meetings: {
        detail: {
          invalidate: jest.fn(),
        },
      },
      notion: {
        exportStatus: {
          invalidate: jest.fn(),
        },
      },
      dictionary: {
        list: {
          invalidate: jest.fn(),
        },
      },
    }),
    notion: {
      status: {
        useQuery: () => mockNotionStatusQuery,
      },
      exportStatus: {
        useQuery: (
          ...args: Parameters<typeof mockNotionExportStatusUseQuery>
        ) => mockNotionExportStatusUseQuery(...args),
      },
      exportMeeting: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({
            ok: true,
            pageUrl: "https://notion.so/page-1",
            exportedNotesVersion: 1,
          }),
          isPending: false,
          error: undefined,
        }),
      },
      syncMeeting: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({
            ok: true,
            pageUrl: "https://notion.so/page-1",
            exportedNotesVersion: 1,
          }),
          isPending: false,
          error: undefined,
        }),
      },
      retryAutomationExport: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({
            ok: true,
            pageUrl: "https://notion.so/page-1",
            exportedNotesVersion: 1,
          }),
          isPending: false,
          error: undefined,
        }),
      },
    },
    meetingShares: {
      getShareState: {
        useQuery: () => mockShareStateQuery,
      },
      setVisibility: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({
            meetingSharingPolicy: "server",
            state: {
              visibility: "server",
              shareId: "sh_mock",
              rotated: false,
            },
          }),
          isPending: false,
          error: undefined,
        }),
      },
      rotate: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({
            meetingSharingPolicy: "server",
            state: {
              visibility: "server",
              shareId: "sh_rotated",
              rotated: true,
            },
          }),
          isPending: false,
          error: undefined,
        }),
      },
    },
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
          mutateAsync: mockSuggestNotesCorrection,
          isPending: false,
          error: undefined,
        }),
      },
      applyNotesCorrection: {
        useMutation: () => ({
          mutateAsync: mockApplyNotesCorrection,
          isPending: false,
          error: undefined,
        }),
      },
      updateNotes: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({ ok: true }),
          isPending: false,
          error: undefined,
        }),
      },
      importNotes: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({ ok: true }),
          isPending: false,
          error: undefined,
        }),
      },
      personalShareState: {
        useQuery: () => mockPersonalShareStateQuery,
      },
      setPersonalShareGrants: {
        useMutation: () => ({
          mutateAsync: mockSetPersonalShareGrants,
          isPending: false,
          error: undefined,
        }),
      },
    },
    dictionary: {
      previewTeaching: {
        useMutation: () => ({
          mutateAsync: mockPreviewTeaching,
          isPending: false,
        }),
      },
      commitTeaching: {
        useMutation: () => ({
          mutateAsync: jest.fn().mockResolvedValue({ results: [] }),
          isPending: false,
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
    hide: jest.fn(),
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
  audioAccessEnabled: true,
  transcriptAccessEnabled: true,
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
  notesVersion: 1,
  meetingName: null,
  summarySentence: null,
  summaryLabel: null,
  notesChannelId: null,
  notesMessageId: null,
  transcript: "",
  transcriptAccessEnabled: true,
  audioUrl: null,
  audioAccessEnabled: true,
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

const renderDrawer = (overrides?: {
  canManageSelectedGuild?: boolean;
  selectedGuildId?: string;
}) =>
  render(
    <MantineProvider>
      <MeetingDetailDrawer
        opened
        selectedMeetingId="m1"
        selectedGuildId={overrides?.selectedGuildId ?? "g1"}
        canManageSelectedGuild={overrides?.canManageSelectedGuild ?? true}
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
    mockShareStateQuery.data = {
      meetingSharingPolicy: "server",
      state: { visibility: "private" },
    };
    mockShareStateQuery.error = null;
    mockPersonalShareStateQuery.data = {
      accessGrants: [
        { targetType: "user" as const, userId: "111111111111111111" },
      ],
    };
    mockPersonalShareStateQuery.error = null;
    mockPersonalShareStateQuery.refetch.mockClear();
    mockSetPersonalShareGrants.mockClear();
    mockSuggestNotesCorrection.mockClear();
    mockApplyNotesCorrection.mockClear();
    mockApplyNotesCorrection.mockResolvedValue({
      ok: true,
      dictionaryTeachingContextToken: "11111111-1111-4111-8111-111111111111",
      dictionaryTeachingContextExpiresAtMs: Date.now() + 15 * 60 * 1_000,
      dictionaryTeachingInstruction:
        "It wrote John Smith, but his name is Jon Smythe.",
    });
    mockPreviewTeaching.mockClear();
    mockNotionStatusQuery.data = { configured: true, connected: false };
    mockNotionExportStatusQuery.data = {
      exported: false,
      currentNotesVersion: 1,
      outdated: false,
    };
    mockNotionExportStatusQuery.isLoading = false;
    mockNotionExportStatusQuery.isFetching = false;
    mockNotionExportStatusQuery.error = null;
    mockNotionExportStatusUseQuery.mockClear();
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

  it("shows server access notices instead of transcript and audio", () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          transcript: "Hidden transcript",
          transcriptAccessEnabled: false,
          audioUrl: "https://example.com/recording.mp3",
          audioAccessEnabled: false,
        }),
        meeting: buildMeeting({
          transcriptAccessEnabled: false,
          audioAccessEnabled: false,
          audioUrl: "https://example.com/recording.mp3",
        }),
      }),
    );

    renderDrawer();

    expect(
      screen.getByText("Transcript access is disabled for this server."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Audio recording access is disabled for this server."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Hidden transcript")).not.toBeInTheDocument();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("disables share button when sharing permission is denied", () => {
    mockShareStateQuery.error = { data: { code: "FORBIDDEN" } };

    renderDrawer();

    expect(screen.getByTestId("meeting-share")).toBeDisabled();
  });

  it("updates explicit personal meeting share grants", async () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          ownershipScope: "personal",
          ownerUserId: "user-1",
          personalShareManageable: true,
        }),
      }),
    );

    renderDrawer();
    fireEvent.click(screen.getByTestId("meeting-share"));
    fireEvent.change(await screen.findByTestId("personal-share-user-ids"), {
      target: { value: "222222222222222222" },
    });
    fireEvent.change(screen.getByTestId("personal-share-guild-ids"), {
      target: { value: "333333333333333333" },
    });
    fireEvent.click(screen.getByTestId("personal-share-save"));

    await waitFor(() =>
      expect(mockSetPersonalShareGrants).toHaveBeenCalledWith({
        serverId: "g1",
        meetingId: "m1",
        userIds: ["222222222222222222"],
        guildIds: ["333333333333333333"],
      }),
    );
  });

  it("shows archive actions for personal meeting owners", () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          ownershipScope: "personal",
          ownerUserId: "user-1",
          personalShareManageable: true,
        }),
      }),
    );

    renderDrawer({
      canManageSelectedGuild: false,
      selectedGuildId: "personal:user-1",
    });

    expect(screen.getByTestId("meeting-archive")).toBeEnabled();
  });

  it("does not query Notion export status when Notion is not configured", () => {
    mockNotionStatusQuery.data = { configured: false, connected: false };

    renderDrawer();

    expect(mockNotionExportStatusUseQuery).toHaveBeenCalledWith(
      { serverId: "g1", meetingId: "m1" },
      { enabled: false },
    );
  });

  it("disables Notion export actions while export status is loading", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = undefined;
    mockNotionExportStatusQuery.isLoading = true;

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(
      (await screen.findByText("Loading Notion status...")).closest("button"),
    ).toBeDisabled();
  });

  it("disables Notion export actions when export status fails", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = undefined;
    mockNotionExportStatusQuery.error = new Error("boom");

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(
      (await screen.findByText("Notion status unavailable")).closest("button"),
    ).toBeDisabled();
  });

  it("shows a retry action for failed automated Notion exports", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = {
      exported: false,
      source: "automation",
      currentNotesVersion: 1,
      outdated: false,
      lastError: "Reconnect Notion.",
    };

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(await screen.findByText("Retry Notion automation")).toBeEnabled();
  });

  it("shows personal Notion retry for the personal meeting owner", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = {
      exported: false,
      source: "automation",
      currentNotesVersion: 1,
      outdated: false,
      lastError: "Reconnect Notion.",
    };
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          ownershipScope: "personal",
          ownerUserId: "user-1",
          personalShareManageable: true,
        }),
      }),
    );

    renderDrawer({
      canManageSelectedGuild: false,
      selectedGuildId: "personal:user-1",
    });
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(await screen.findByText("Retry Notion automation")).toBeEnabled();
  });

  const applyCorrection = async () => {
    fireEvent.click(screen.getByLabelText("Notes actions"));
    fireEvent.click(await screen.findByText("Suggest correction (AI)"));
    fireEvent.change(await screen.findByLabelText("Suggestion"), {
      target: {
        value: "It wrote John Smith, but his name is Jon Smythe.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate proposal" }));
    await screen.findByText("+ mock diff");
    fireEvent.click(screen.getByRole("button", { name: "Apply update" }));
    await waitFor(() => expect(mockApplyNotesCorrection).toHaveBeenCalled());
  };

  it("offers an explicit dictionary-teaching step after a manager applies a correction", async () => {
    jest.mocked(notifications.show).mockClear();
    renderDrawer({ canManageSelectedGuild: true });

    await applyCorrection();

    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "notes-correction-teaching-offer",
        title: "Notes updated",
        autoClose: expect.any(Number),
      }),
    );
  });

  it("preserves correction teaching context across a detail refresh", async () => {
    jest.mocked(notifications.show).mockClear();
    const view = renderDrawer({ canManageSelectedGuild: true });

    await applyCorrection();
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          notes: "- Decision: Ship it\n- Contact: Jon Smythe",
          notesVersion: 2,
        }),
        meeting: buildMeeting({
          notes: "- Decision: Ship it\n- Contact: Jon Smythe",
        }),
      }),
    );
    view.rerender(
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

    const offer = jest
      .mocked(notifications.show)
      .mock.calls.map(([options]) => options)
      .find((options) => options.id === "notes-correction-teaching-offer");
    render(<MantineProvider>{offer?.message}</MantineProvider>);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Teach Chronote from this correction",
      }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Teach Chronote" }),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "It wrote John Smith, but his name is Jon Smythe.",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to instruction-only teaching after correction context expires", async () => {
    const expiresAtMs = Date.now() + 1_000;
    mockApplyNotesCorrection.mockResolvedValueOnce({
      ok: true,
      dictionaryTeachingContextToken: "11111111-1111-4111-8111-111111111111",
      dictionaryTeachingContextExpiresAtMs: expiresAtMs,
      dictionaryTeachingInstruction:
        "It wrote John Smith, but his name is Jon Smythe.",
    });
    jest.mocked(notifications.show).mockClear();
    renderDrawer({ canManageSelectedGuild: true });

    await applyCorrection();
    const offer = jest
      .mocked(notifications.show)
      .mock.calls.map(([options]) => options)
      .find((options) => options.id === "notes-correction-teaching-offer");
    render(<MantineProvider>{offer?.message}</MantineProvider>);
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(expiresAtMs);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Teach Chronote from this correction",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review terms" }),
    );

    await waitFor(() =>
      expect(mockPreviewTeaching).toHaveBeenCalledWith({
        serverId: "g1",
        instruction: "It wrote John Smith, but his name is Jon Smythe.",
        correctionContextToken: undefined,
      }),
    );
    nowSpy.mockRestore();
  });

  it("does not offer dictionary teaching to a member without Manage Server", async () => {
    jest.mocked(notifications.show).mockClear();
    renderDrawer({ canManageSelectedGuild: false });

    await applyCorrection();

    expect(notifications.show).toHaveBeenCalledWith({
      message: "Notes updated.",
    });
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "notes-correction-teaching-offer" }),
    );
  });
});
