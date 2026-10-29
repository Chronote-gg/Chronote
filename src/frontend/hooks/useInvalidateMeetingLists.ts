import { useCallback } from "react";
import { trpc } from "../services/trpc";

export const useInvalidateMeetingLists = (serverId: string | null) => {
  const trpcUtils = trpc.useUtils();

  return useCallback(async () => {
    await trpcUtils.meetings.myList.invalidate();
    if (!serverId) return;
    await Promise.all([
      trpcUtils.meetings.list.invalidate({
        serverId,
        archivedOnly: false,
      }),
      trpcUtils.meetings.list.invalidate({
        serverId,
        archivedOnly: true,
      }),
      trpcUtils.meetings.list.invalidate({
        serverId,
        includeArchived: true,
      }),
    ]);
  }, [serverId, trpcUtils.meetings.list, trpcUtils.meetings.myList]);
};
