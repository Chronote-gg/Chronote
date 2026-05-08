import type { Meta, StoryObj } from "@storybook/react";
import MeetingNotesImportModal from "./MeetingNotesImportModal";

const meta: Meta<typeof MeetingNotesImportModal> = {
  title: "Library/MeetingNotesImportModal",
  component: MeetingNotesImportModal,
  args: {
    opened: true,
    saving: false,
    onClose: () => {},
    onImport: () => {},
  },
};

export default meta;

type Story = StoryObj<typeof MeetingNotesImportModal>;

export const Default: Story = {};

export const Saving: Story = {
  args: {
    saving: true,
  },
};
