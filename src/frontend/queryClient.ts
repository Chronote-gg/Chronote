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
      return !(
        Array.isArray(path) &&
        path.length === 2 &&
        path[0] === "auth" &&
        path[1] === "me"
      );
    },
  };
  await queryClient.cancelQueries(filters);
  queryClient.removeQueries(filters);
}
