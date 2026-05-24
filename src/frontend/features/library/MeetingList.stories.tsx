import type { Meta, StoryObj } from "@storybook/react";
import { MeetingList } from "./MeetingList";
import type { MeetingListItem } from "../../pages/library/types";
import { MEETING_STATUS } from "../../../types/meetingLifecycle";

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
