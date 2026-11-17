import { buildQueryState, resetQueryState, type QueryState } from "./trpcState";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../src/trpc/router";
export type AskSettingsData = {
  askMembersEnabled: boolean;
  askSharingPolicy: "off" | "server" | "public";
  agentEnabled?: boolean;
  searchEnabled?: boolean;
};
const startingData =
  (): inferRouterOutputs<AppRouter>["ask"]["startingContext"] => ({
    coverage: {
      status: "ready",
      semanticStatus: "ready",
      ranking: "authorized_partition_order",
    },
    meetings: [],
  });
const settingsData = (): AskSettingsData => ({
  agentEnabled: true,
  searchEnabled: true,
  askMembersEnabled: true,
  askSharingPolicy: "server",
});
const searchData = () => ({
  hits: [],
  nextCursor: null,
  coverage: { status: "ready" },
});
export const askStartingContextQuery = buildQueryState(startingData());
export const askSettingsQuery = buildQueryState(settingsData());
export const askSearchQuery = buildQueryState(searchData());
export function resetAskQueries() {
  resetQueryState(askStartingContextQuery, startingData());
  resetQueryState(askSettingsQuery, settingsData());
  resetQueryState(askSearchQuery, searchData());
}

export const askQueryMocks = {
  settings: {
    useQuery: () => ({
      ...askSettingsQuery,
      isSuccess: !askSettingsQuery.isLoading && !askSettingsQuery.error,
    }),
  },
  startingContext: { useQuery: () => askStartingContextQuery },
  searchMeetings: { useQuery: () => askSearchQuery },
};
export const setAskSettingsQuery = (
  next: Partial<QueryState<AskSettingsData>>,
) => {
  Object.assign(askSettingsQuery, next);
};
