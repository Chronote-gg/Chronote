import type { MeetingDetailInput } from "../../../utils/meetingLibrary";
import { notifications } from "@mantine/notifications";
import type { MeetingUpdatePublicDelivery } from "../../../../services/meetingUpdateStatus";
import { trpc } from "../../../services/trpc";
import type { QuillDeltaPayload } from "../components/MeetingNotesEditorModal";
import type { ImportNotesPayload } from "../components/MeetingNotesImportModal";
import { meetingUpdateSaveCopy } from "../components/MeetingUpdateDeliveryStatus";
import type { useMeetingUpdateFeedback } from "./useMeetingUpdateFeedback";

type SaveContext = {
  serverId: string;
  meetingId: string;
  expectedPreviousVersion: number;
};
export function useMeetingNotesSaves(params: {
  selectedGuildId: string | null;
  selectedMeetingId: string | null;
  detail: MeetingDetailInput | null;
  feedback: ReturnType<typeof useMeetingUpdateFeedback>;
  onEditorSaved: () => void;
  onImported: () => void;
}) {
  const updateNotesMutation = trpc.meetings.updateNotes.useMutation();
  const importNotesMutation = trpc.meetings.importNotes.useMutation();
  const save = async (
    action: (
      context: SaveContext,
    ) => Promise<{ delivery: MeetingUpdatePublicDelivery }>,
    onSaved: () => void,
    failure: string,
  ) => {
    if (!params.selectedGuildId || !params.selectedMeetingId) return;
    const notesVersion = params.detail?.notesVersion;
    if (notesVersion == null) {
      notifications.show({
        color: "red",
        message: failure + " Refresh and try again.",
      });
      return;
    }
    const key = params.feedback.selectionKey;
    try {
      const result = await action({
        serverId: params.selectedGuildId,
        meetingId: params.selectedMeetingId,
        expectedPreviousVersion: notesVersion,
      });
      if (!params.feedback.acknowledgeSave(result.delivery, key)) return;
      notifications.show({ message: meetingUpdateSaveCopy(result.delivery) });
      onSaved();
      await params.feedback.refreshSavedMeeting();
    } catch (error) {
      if (!params.feedback.isCurrentSelection(key)) return;
      notifications.show({
        color: "red",
        message:
          error instanceof Error && error.message ? error.message : failure,
      });
    }
  };
  return {
    updateNotesMutation,
    importNotesMutation,
    handleNotesEditorSave: (delta: QuillDeltaPayload) =>
      save(
        (context) => updateNotesMutation.mutateAsync({ ...context, delta }),
        params.onEditorSaved,
        "Unable to save notes right now.",
      ),
    handleNotesImport: (payload: ImportNotesPayload) =>
      save(
        (context) =>
          importNotesMutation.mutateAsync({ ...context, ...payload }),
        params.onImported,
        "Unable to import notes right now.",
      ),
  };
}
