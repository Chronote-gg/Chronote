import { useEffect, useRef, useState } from "react";
import { trpc } from "../../../services/trpc";
import type { MeetingUpdatePublicDelivery } from "../../../../services/meetingUpdateStatus";

export function useMeetingUpdateFeedback(params: {
  opened: boolean;
  selectedGuildId: string | null;
  selectedMeetingId: string | null;
  invalidateMeetingLists: () => Promise<void>;
}) {
  const trpcUtils = trpc.useUtils();
  const selectionKey = `${params.selectedGuildId}/${params.selectedMeetingId}`;
  const activeSelection = useRef<string | null>(null);
  const [saved, setSaved] = useState<{
    key: string;
    delivery: MeetingUpdatePublicDelivery;
  } | null>(null);
  useEffect(() => {
    activeSelection.current = params.opened ? selectionKey : null;
    return () => {
      activeSelection.current = null;
    };
  }, [params.opened, selectionKey]);
  const isCurrentSelection = (key: string) => activeSelection.current === key;
  const acknowledgedDelivery =
    saved?.key === selectionKey ? saved.delivery : undefined;
  const acknowledgeSave = (
    delivery: MeetingUpdatePublicDelivery,
    key: string,
  ) => {
    if (!isCurrentSelection(key)) return false;
    setSaved({ key, delivery });
    return true;
  };
  const resolveDelivery = (read: MeetingUpdatePublicDelivery | undefined) =>
    acknowledgedDelivery &&
    (!read || read.desiredRevision < acknowledgedDelivery.desiredRevision)
      ? acknowledgedDelivery
      : read;
  const refreshSavedMeeting = () =>
    Promise.allSettled([
      trpcUtils.meetings.detail.invalidate(),
      trpcUtils.notion.exportStatus.invalidate(),
      params.invalidateMeetingLists(),
    ]);
  return {
    selectionKey,
    acknowledgedDelivery,
    acknowledgeSave,
    resolveDelivery,
    isCurrentSelection,
    refreshSavedMeeting,
    resetDeliveryFeedback: () => setSaved(null),
  };
}
