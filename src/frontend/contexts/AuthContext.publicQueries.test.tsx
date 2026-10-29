import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { queryClient } from "../queryClient";
import { AuthProvider, useAuth } from "./AuthContext";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
let mockIdentity = deferred<null>();
jest.mock("../services/trpc", () => ({
  trpc: {
    auth: {
      me: {
        useQuery: () =>
          useQuery({
            queryKey: [["auth", "me"], { type: "query" }],
            queryFn: () => mockIdentity.promise,
            retry: false,
          }),
      },
    },
  },
}));
jest.mock("../services/analytics", () => ({
  identifyUser: jest.fn(),
  resetAnalyticsIdentity: jest.fn(),
}));

beforeEach(() => {
  mockIdentity = deferred<null>();
});
afterEach(() => queryClient.clear());

test.each([
  ["pricing", "plans"],
  ["meetingShares", "getPublicMeeting"],
  ["ask", "getPublicConversation"],
])(
  "first signed-out identity preserves in-flight public %s.%s",
  async (router, procedure) => {
    const response = deferred<string>();
    function PublicProbe() {
      const query = useQuery({
        queryKey: [[router, procedure], { type: "query" }],
        queryFn: ({ signal }) => {
          // Consume the signal just as tRPC does, so cancellation is observable.
          signal.addEventListener("abort", () => {});
          return response.promise;
        },
      });
      return <div>{query.data ?? "public pending"}</div>;
    }
    function GateProbe() {
      const auth = useAuth();
      return (
        <div>
          {auth.protectedQueriesReady ? "identity ready" : "identity pending"}
        </div>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <GateProbe />
          <PublicProbe />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await act(async () => mockIdentity.resolve(null));
    await waitFor(() =>
      expect(screen.getByText(/identity ready/)).toBeInTheDocument(),
    );
    await act(async () => response.resolve("public result"));
    await waitFor(() =>
      expect(screen.getByText(/public result/)).toBeInTheDocument(),
    );
  },
);
