import { notifications } from "@mantine/notifications";
import { trpc } from "../../../services/trpc";
import type { MeetingDetailInput } from "../../../utils/meetingLibrary";
import type { MeetingProcessingRetryProps } from "../components/MeetingProcessingRetry";

export function useProcessingRetry(
  serverId: string | null,
  detail: MeetingDetailInput | null,
  invalidateMeetingLists: () => Promise<void>,
): MeetingProcessingRetryProps | undefined {
  const trpcUtils = trpc.useUtils();
  const mutation = trpc.meetings.retryProcessing.useMutation({
    onError: (error) => {
      notifications.show({ color: "red", message: error.message });
    },
    onSettled: () =>
      Promise.all([
        trpcUtils.meetings.detail.invalidate(),
        invalidateMeetingLists(),
      ]),
  });
  const view = detail?.processingRetry;
  if (!serverId || !detail || !view) return undefined;
  return {
    view,
    pending: mutation.isPending,
    onRetry: (replaceNotes) =>
      mutation.mutate({ serverId, meetingId: detail.id, replaceNotes }),
  };
}
