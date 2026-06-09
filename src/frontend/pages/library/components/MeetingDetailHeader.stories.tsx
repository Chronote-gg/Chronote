import type { Meta, StoryObj } from "@storybook/react";
import { MEETING_STATUS } from "../../../../types/meetingLifecycle";
import type { MeetingDetails } from "../../../utils/meetingLibrary";
import MeetingDetailHeader from "./MeetingDetailHeader";

const meeting: MeetingDetails = {
  id: "personal#2026-01-06T18:00:00.000Z",
  meetingId: "upload-1",
  title: "Desktop planning recording",
  summary: "A short recap of a personal desktop recording.",
  notes: "- Decision: Keep the recorder flow simple.",
  dateLabel: "Jan 6, 2026",
  durationLabel: "12m",
  tags: ["desktop"],
  channel: "#Uploaded media",
  audioUrl: null,
  archivedAt: null,
  attendees: ["Me"],
  decisions: [],
  actions: [],
  events: [],
  status: MEETING_STATUS.COMPLETE,
};

const meta: Meta<typeof MeetingDetailHeader> = {
  title: "Library/MeetingDetailHeader",
  component: MeetingDetailHeader,
  args: {
    meeting,
    displayStatus: MEETING_STATUS.COMPLETE,
    canManageSelectedGuild: false,
    canManageMeetingMetadata: true,
    endMeetingPreflightLoading: false,
    archivePending: false,
    sharePending: false,
    shareDisabled: false,
    fullScreen: false,
    onEndMeeting: () => undefined,
    onDownload: () => undefined,
    onShare: () => undefined,
    onArchiveToggle: () => undefined,
    onToggleFullScreen: () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof MeetingDetailHeader>;

export const PersonalOwnerActions: Story = {};

export const Archived: Story = {
  args: {
    meeting: {
      ...meeting,
      archivedAt: "2026-01-07T18:00:00.000Z",
    },
  },
};
