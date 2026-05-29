import type { Meta, StoryObj } from "@storybook/react";
import { PersonalMeetingShareModal } from "./PersonalMeetingShareModal";

const meta: Meta<typeof PersonalMeetingShareModal> = {
  title: "Meetings/PersonalMeetingShareModal",
  component: PersonalMeetingShareModal,
  args: {
    opened: true,
    onClose: () => undefined,
    meetingTitle: "Discovery call",
    accessGrants: [
      { targetType: "user", userId: "123456789012345678" },
      { targetType: "guild", guildId: "234567890123456789" },
    ],
    saving: false,
    error: null,
    onSave: () => undefined,
  },
};

export default meta;

type Story = StoryObj<typeof PersonalMeetingShareModal>;

export const Default: Story = {};

export const Saving: Story = {
  args: { saving: true },
};

export const WithError: Story = {
  args: { error: "Use numeric Discord user IDs and server IDs." },
};
