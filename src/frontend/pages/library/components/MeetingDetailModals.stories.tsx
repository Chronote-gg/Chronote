import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import MeetingDetailModals from "./MeetingDetailModals";

const meta: Meta<typeof MeetingDetailModals> = {
  title: "Library/MeetingDetailModals",
  component: MeetingDetailModals,
};

export default meta;

type Story = StoryObj<typeof MeetingDetailModals>;

const DemoModal = (props: {
  notesCorrectionChanged: boolean | null;
  notesCorrectionDiff: string | null;
}) => {
  const [draft, setDraft] = useState("Add the correct owner for the rollout.");
  return (
    <MeetingDetailModals
      notesCorrectionModalOpen
      notesCorrectionDraft={draft}
      notesCorrectionDiff={props.notesCorrectionDiff}
      notesCorrectionChanged={props.notesCorrectionChanged}
      onNotesCorrectionDraftChange={setDraft}
      onNotesCorrectionModalClose={() => undefined}
      onNotesCorrectionGenerate={() => undefined}
      onNotesCorrectionApply={() => undefined}
      notesCorrectionGenerating={false}
      notesCorrectionApplying={false}
      feedbackModalOpen={false}
      feedbackDraft=""
      onFeedbackDraftChange={() => undefined}
      onFeedbackModalClose={() => undefined}
      onFeedbackSubmit={() => undefined}
      feedbackSubmitting={false}
      endMeetingModalOpen={false}
      onEndMeetingModalClose={() => undefined}
      onConfirmEndMeeting={() => undefined}
      endMeetingLoading={false}
      archiveModalOpen={false}
      archiveNextState={null}
      onArchiveModalClose={() => undefined}
      onArchiveConfirm={() => undefined}
      archivePending={false}
      renameModalOpen={false}
      renameDraft=""
      renameError={null}
      onRenameDraftChange={() => undefined}
      onRenameModalClose={() => undefined}
      onRenameSave={() => undefined}
      renamePending={false}
    />
  );
};

export const NotesCorrectionWithDiff: Story = {
  render: () => (
    <DemoModal
      notesCorrectionChanged
      notesCorrectionDiff={
        "- Owner: TBD\n+ Owner: Alice\n- Deadline: Friday\n+ Deadline: Tuesday"
      }
    />
  ),
};

export const NotesCorrectionNoChanges: Story = {
  render: () => (
    <DemoModal notesCorrectionChanged={false} notesCorrectionDiff=" " />
  ),
};
