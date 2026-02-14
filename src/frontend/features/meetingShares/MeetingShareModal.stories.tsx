import type { Meta, StoryObj } from "@storybook/react";
import { MeetingShareModal } from "./MeetingShareModal";

const meta: Meta<typeof MeetingShareModal> = {
  title: "Meetings/ShareModal",
  component: MeetingShareModal,
  args: {
    opened: true,
    onClose: () => undefined,
    meetingTitle: "Weekly sync",
    sharingEnabled: true,
    publicSharingEnabled: true,
    visibility: "public",
    shareUrl: "https://chronote.gg/share/meeting/123/sh_abc",
    shareError: null,
    sharePending: false,
    rotatePending: false,
    onCopyLink: () => undefined,
    onSetVisibility: () => undefined,
    onRotate: () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof MeetingShareModal>;

export const PublicShared: Story = {};

export const ServerShared: Story = {
  args: {
    visibility: "server",
    publicSharingEnabled: false,
    shareUrl: "https://chronote.gg/share/meeting/123/sh_server",
  },
};

export const NotShared: Story = {
  args: {
    visibility: "private",
    shareUrl: "",
  },
};

export const SharingDisabled: Story = {
  args: {
    sharingEnabled: false,
    publicSharingEnabled: false,
    visibility: "private",
    shareUrl: "",
  },
};
