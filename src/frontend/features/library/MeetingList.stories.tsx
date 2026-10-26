import type { Meta, StoryObj } from "@storybook/react";
import { Button, Group } from "@mantine/core";
import { MeetingList } from "./MeetingList";
import type { MeetingListItem } from "../../pages/library/types";
import { MEETING_STATUS } from "../../../types/meetingLifecycle";
import {
  deriveMeetingSummary,
  formatMeetingDurationLabel,
} from "../../utils/meetingLibrary";

const items: MeetingListItem[] = [
  {
    id: "m1",
    meetingId: "meeting-1",
    serverId: "server-1",
    serverName: "Chronote Crew",
    channelId: "c1",
    channelName: "staff-chat",
    timestamp: "2025-12-30T18:30:00.000Z",
    duration: 90,
    tags: ["checks"],
    notes: "Quick mic check.",
    summarySentence: "Quick mic and audio check before the weekly standup.",
    notesChannelId: "n1",
    notesMessageId: "msg-1",
    audioAvailable: true,
    transcriptAvailable: true,
    status: MEETING_STATUS.COMPLETE,
    title: "Mic check",
    summary: "Quick mic and audio check before the weekly standup.",
    dateLabel: "Dec 30, 2025",
    recencyLabel: "2h ago",
    durationLabel: "1m",
    channelLabel: "#staff-chat",
  },
  {
    id: "m2",
    meetingId: "meeting-2",
    serverId: "server-2",
    serverName: "Community Ops",
    channelId: "c2",
    channelName: "planning",
    timestamp: "2025-12-29T17:10:00.000Z",
    duration: 3720,
    tags: ["planning", "roadmap"],
    notes: "Summary and action items.",
    summarySentence:
      "Reviewed the Q1 roadmap, decisions, and key risks for next quarter.",
    notesChannelId: "n2",
    notesMessageId: "msg-2",
    audioAvailable: true,
    transcriptAvailable: true,
    status: MEETING_STATUS.PROCESSING,
    title: "Q1 roadmap review",
    summary:
      "Reviewed the Q1 roadmap, decisions, and key risks for next quarter.",
    dateLabel: "Dec 29, 2025",
    recencyLabel: "Yesterday",
    durationLabel: "1h 02m",
    channelLabel: "#planning",
  },
];

const archivedItems: MeetingListItem[] = [
  {
    ...items[0],
    id: "m3",
    meetingId: "meeting-3",
    title: "Archived planning sync",
    archivedAt: "2025-12-31T12:00:00.000Z",
  },
];

const meta: Meta<typeof MeetingList> = {
  title: "Library/MeetingList",
  tags: ["recording-outcomes"],
  component: MeetingList,
  args: {
    items,
    listLoading: false,
    listError: false,
    onSelect: () => undefined,
    selectedMeetingId: "m1",
  },
};

export default meta;

type Story = StoryObj<typeof MeetingList>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    listLoading: true,
  },
};

export const Empty: Story = {
  args: {
    items: [],
  },
};

export const EmptyWithAction: Story = {
  args: {
    items: [],
    emptyTitle: "No meetings found here yet.",
    emptyDescription:
      "Choose a server to browse its Library, Ask threads, billing, and settings.",
    emptyActionLabel: "View servers",
    onEmptyAction: () => undefined,
  },
};

export const Archived: Story = {
  args: {
    items: archivedItems,
  },
};
export const Interrupted: Story = {
  args: {
    items: [
      {
        ...items[0],
        status: "interrupted",
        durationLabel: "Unknown duration",
        capture: {
          kind: "interrupted",
          startedAt: "2026-01-01T00:00:00Z",
          detectedAt: "2026-01-01T01:00:00Z",
          endedAt: null,
        },
        recoveryNotice: "Saved recording recovery finished.",
      },
      { ...items[1], status: "starting" },
    ],
  },
};

export const Paginated: Story = {
  args: {
    footer: (
      <Group justify="center">
        <Button variant="light" color="brand">
          Load more
        </Button>
      </Group>
    ),
  },
};

const recoveryListItem = (
  outcome: "disabled" | "no_usable_speech",
): MeetingListItem => {
  const row = {
    ...items[0],
    title:
      outcome === "disabled"
        ? "Generated notes-disabled recovery"
        : "Generated no-speech recovery",
    status: "interrupted" as const,
    duration: 0,
    notes: "",
    summarySentence: undefined,
    capture: {
      kind: "interrupted" as const,
      startedAt: "2026-01-01T00:00:00Z",
      detectedAt: "2026-01-01T00:30:00Z",
      endedAt: null,
    },
    recoveryNotice:
      outcome === "disabled"
        ? "Recovery finished with the original transcription and notes settings."
        : "No usable saved speech was found.",
    recovery: {
      disposition: "done" as const,
      stage: "notes" as const,
      outcome,
    },
  };
  return {
    ...row,
    durationLabel: formatMeetingDurationLabel(row),
    summary: deriveMeetingSummary(row),
  };
};
export const MyMeetingsNotesDisabled: Story = {
  tags: ["r5-fix1", "r5-fix1-list"],
  args: { items: [recoveryListItem("disabled")] },
};
export const MyMeetingsNoUsableSpeech: Story = {
  tags: ["r5-fix1", "r5-fix1-list"],
  args: { items: [recoveryListItem("no_usable_speech")] },
};
