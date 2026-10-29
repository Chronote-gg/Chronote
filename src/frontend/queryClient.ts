import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

export async function resetMeetingSessionQueries(): Promise<void> {
  const filters = {
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
  await queryClient.cancelQueries(filters);
  queryClient.removeQueries(filters);
}
