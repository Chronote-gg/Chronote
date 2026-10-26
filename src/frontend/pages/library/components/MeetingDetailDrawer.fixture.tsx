import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
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

const mockPendingDelivery = {
  status: "pending" as const,
  reason: null,
  pollable: true as const,
  desiredRevision: 2,
  syncedRevision: null,
  lastSuccess: null,
};
const mockUpdateNotes = jest.fn();
const mockImportNotes = jest.fn();
const mockRename = jest.fn();
const mockApplyNotesCorrection = jest.fn().mockResolvedValue({
  ok: true,
  kind: "saved",
  delivery: mockPendingDelivery,
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
          mutateAsync: mockRename,
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
          mutateAsync: mockUpdateNotes,
          isPending: false,
          error: undefined,
        }),
      },
      importNotes: {
        useMutation: () => ({
          mutateAsync: mockImportNotes,
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

jest.mock("./MeetingNotesEditorModal", () => ({
  __esModule: true,
  default: (p: {
    opened: boolean;
    onSave: (delta: { ops: unknown[] }) => void;
  }) =>
    p.opened ? (
      <button
        onClick={() =>
          p.onSave({ ops: [{ insert: "Edited synthetic notes\\n" }] })
        }
      >
        Confirm synthetic edit
      </button>
    ) : null,
}));
jest.mock("./MeetingNotesImportModal", () => ({
  __esModule: true,
  default: (p: {
    opened: boolean;
    onImport: (payload: { notes: string; mode: "replace" }) => void;
  }) =>
    p.opened ? (
      <button
        onClick={() =>
          p.onImport({ notes: "Imported synthetic notes", mode: "replace" })
        }
      >
        Confirm synthetic import
      </button>
    ) : null,
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

export function resetDrawerFixtures(writeTextMock: ReturnType<typeof jest.fn>) {
  useMeetingDetailMock.mockReturnValue(buildUseMeetingDetailResult());
  writeTextMock.mockClear();
  mockUpdateNotes.mockReset().mockResolvedValue({
    ok: true,
    kind: "saved",
    delivery: mockPendingDelivery,
  });
  mockImportNotes.mockReset().mockResolvedValue({
    ok: true,
    kind: "saved",
    delivery: mockPendingDelivery,
  });
  mockRename.mockReset().mockResolvedValue({
    meetingName: "Renamed",
    kind: "saved",
    delivery: mockPendingDelivery,
  });
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
    kind: "saved",
    delivery: mockPendingDelivery,
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
}
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
export {
  useMeetingDetailMock,
  buildMeeting,
  buildDetail,
  buildUseMeetingDetailResult,
  renderDrawer,
  mockShareStateQuery,
  mockPersonalShareStateQuery,
  mockSetPersonalShareGrants,
  mockSuggestNotesCorrection,
  mockApplyNotesCorrection,
  mockPreviewTeaching,
  mockNotionStatusQuery,
  mockNotionExportStatusQuery,
  mockNotionExportStatusUseQuery,
  mockUpdateNotes,
  mockImportNotes,
  mockRename,
  mockPendingDelivery,
  applyCorrection,
};
