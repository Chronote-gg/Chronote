import type { Meta, StoryObj } from "@storybook/react";
import MeetingNotesEditorModal from "./MeetingNotesEditorModal";

const meta: Meta<typeof MeetingNotesEditorModal> = {
  title: "Library/MeetingNotesEditorModal",
  component: MeetingNotesEditorModal,
};

export default meta;

type Story = StoryObj<typeof MeetingNotesEditorModal>;

export const Default: Story = {
  render: () => (
    <MeetingNotesEditorModal
      opened
      initialMarkdown={
        "# Notes\n\n- Decision: Ship the beta\n- Action: Follow up with @Alice\n\n## Next steps\n\nWrite up a rollout plan."
      }
      saving={false}
      onClose={() => undefined}
      onSave={() => undefined}
    />
  ),
};
