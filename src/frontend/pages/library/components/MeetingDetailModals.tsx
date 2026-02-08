import {
  Box,
  Button,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";

type MeetingDetailModalsProps = {
  notesCorrectionModalOpen: boolean;
  notesCorrectionDraft: string;
  notesCorrectionDiff: string | null;
  notesCorrectionChanged: boolean | null;
  onNotesCorrectionDraftChange: (value: string) => void;
  onNotesCorrectionModalClose: () => void;
  onNotesCorrectionGenerate: () => void;
  onNotesCorrectionApply: () => void;
  notesCorrectionGenerating: boolean;
  notesCorrectionApplying: boolean;
  feedbackModalOpen: boolean;
  feedbackDraft: string;
  onFeedbackDraftChange: (value: string) => void;
  onFeedbackModalClose: () => void;
  onFeedbackSubmit: () => void;
  feedbackSubmitting: boolean;
  endMeetingModalOpen: boolean;
  onEndMeetingModalClose: () => void;
  onConfirmEndMeeting: () => void;
  endMeetingLoading: boolean;
  archiveModalOpen: boolean;
  archiveNextState: boolean | null;
  onArchiveModalClose: () => void;
  onArchiveConfirm: () => void;
  archivePending: boolean;
  renameModalOpen: boolean;
  renameDraft: string;
  renameError: string | null;
  onRenameDraftChange: (value: string) => void;
  onRenameModalClose: () => void;
  onRenameSave: () => void;
  renamePending: boolean;
};

export default function MeetingDetailModals({
  notesCorrectionModalOpen,
  notesCorrectionDraft,
  notesCorrectionDiff,
  notesCorrectionChanged,
  onNotesCorrectionDraftChange,
  onNotesCorrectionModalClose,
  onNotesCorrectionGenerate,
  onNotesCorrectionApply,
  notesCorrectionGenerating,
  notesCorrectionApplying,
  feedbackModalOpen,
  feedbackDraft,
  onFeedbackDraftChange,
  onFeedbackModalClose,
  onFeedbackSubmit,
  feedbackSubmitting,
  endMeetingModalOpen,
  onEndMeetingModalClose,
  onConfirmEndMeeting,
  endMeetingLoading,
  archiveModalOpen,
  archiveNextState,
  onArchiveModalClose,
  onArchiveConfirm,
  archivePending,
  renameModalOpen,
  renameDraft,
  renameError,
  onRenameDraftChange,
  onRenameModalClose,
  onRenameSave,
  renamePending,
}: MeetingDetailModalsProps) {
  const archiveTitle = archiveNextState
    ? "Archive meeting"
    : "Unarchive meeting";
  const archiveMessage = archiveNextState
    ? "Archived meetings move to the Archived view. You can unarchive anytime."
    : "This meeting will move back to the active list.";

  return (
    <>
      <Modal
        opened={notesCorrectionModalOpen}
        onClose={onNotesCorrectionModalClose}
        title="Suggest a correction"
        centered
        size="lg"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Describe what should change in the notes. We'll propose a minimal
            edit diff, then you can apply it.
          </Text>
          <Textarea
            label="Suggestion"
            placeholder="e.g., Add that Alice owns the rollout, and remove the incorrect deadline"
            value={notesCorrectionDraft}
            onChange={(event) =>
              onNotesCorrectionDraftChange(event.currentTarget.value)
            }
            minRows={4}
            maxLength={1500}
            disabled={notesCorrectionGenerating || notesCorrectionApplying}
          />
          {notesCorrectionDiff !== null ? (
            <Box>
              <Text size="sm" fw={600} mb={6}>
                Proposed diff
              </Text>
              <ScrollArea
                h={260}
                offsetScrollbars
                type="always"
                scrollbarSize={10}
              >
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    borderRadius: 8,
                    background: "var(--mantine-color-dark-6)",
                    color: "var(--mantine-color-gray-0)",
                    fontSize: 12,
                    lineHeight: 1.35,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {notesCorrectionDiff}
                </pre>
              </ScrollArea>
              {notesCorrectionChanged === false ? (
                <Text size="xs" c="dimmed" mt={6}>
                  No changes were suggested for this request. Try adding more
                  detail.
                </Text>
              ) : null}
            </Box>
          ) : null}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={onNotesCorrectionModalClose}
              disabled={notesCorrectionGenerating || notesCorrectionApplying}
            >
              Cancel
            </Button>
            {notesCorrectionDiff !== null ? (
              <Button
                color="brand"
                onClick={onNotesCorrectionApply}
                loading={notesCorrectionApplying}
                disabled={notesCorrectionChanged === false}
              >
                Apply update
              </Button>
            ) : (
              <Button
                color="brand"
                onClick={onNotesCorrectionGenerate}
                loading={notesCorrectionGenerating}
              >
                Generate proposal
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={feedbackModalOpen}
        onClose={onFeedbackModalClose}
        title="Summary feedback"
        centered
      >
        <Stack gap="md">
          <Textarea
            label="What could be better? (optional)"
            placeholder="Add detail that helps improve the summary."
            value={feedbackDraft}
            onChange={(event) =>
              onFeedbackDraftChange(event.currentTarget.value)
            }
            minRows={4}
            maxLength={1000}
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={onFeedbackModalClose}
              disabled={feedbackSubmitting}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={onFeedbackSubmit}
              loading={feedbackSubmitting}
            >
              Send feedback
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={endMeetingModalOpen}
        onClose={onEndMeetingModalClose}
        title="End live meeting"
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            This will stop recording and begin processing notes. Are you sure
            you want to end the meeting?
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={onEndMeetingModalClose}
              disabled={endMeetingLoading}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={onConfirmEndMeeting}
              loading={endMeetingLoading}
            >
              End meeting
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={archiveModalOpen}
        onClose={onArchiveModalClose}
        title={archiveTitle}
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {archiveMessage}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onArchiveModalClose}>
              Cancel
            </Button>
            <Button
              color={archiveNextState ? "red" : "brand"}
              onClick={onArchiveConfirm}
              loading={archivePending}
              data-testid="meeting-archive-confirm"
            >
              {archiveNextState ? "Archive meeting" : "Unarchive meeting"}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={renameModalOpen}
        onClose={onRenameModalClose}
        title="Rename meeting"
        centered
      >
        <Stack gap="md">
          <TextInput
            label="Meeting name"
            description="5 words or fewer, letters and numbers only."
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.currentTarget.value)}
            error={renameError ?? undefined}
            data-testid="meeting-rename-input"
          />
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={onRenameModalClose}
              disabled={renamePending}
            >
              Cancel
            </Button>
            <Button onClick={onRenameSave} loading={renamePending}>
              Save name
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
