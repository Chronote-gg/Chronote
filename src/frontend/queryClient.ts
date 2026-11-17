import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const sessionQueryFilters = {
  predicate: (query: { queryKey: readonly unknown[] }) => {
    const path = query.queryKey[0];
    if (!Array.isArray(path) || path.length !== 2) return true;
    // These reads do not depend on the actor. Removing an observed public
    // query during identity resolution can strand its consumer pending until
    // it rerenders. All other data still crosses the session reset boundary.
    return ![
      "auth.me",
      "pricing.plans",
      "meetingShares.getPublicMeeting",
      "ask.getPublicConversation",
    ].includes(path.join("."));
  },
};
export async function cancelMeetingSessionQueries(): Promise<void> {
  await queryClient.cancelQueries(sessionQueryFilters);
}
export async function resumeMeetingSessionQueries(): Promise<void> {
  await queryClient.invalidateQueries(sessionQueryFilters);
}
export async function resetMeetingSessionQueries(): Promise<void> {
  await cancelMeetingSessionQueries();
  queryClient.removeQueries(sessionQueryFilters);
}
