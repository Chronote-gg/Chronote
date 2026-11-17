import { act, render, screen } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";
const mockReset = jest.fn();
let mockActor: { id: string; username: string; avatar: null } | null = {
  id: "a",
  username: "a",
  avatar: null,
};
jest.mock("../services/trpc", () => ({
  trpc: {
    auth: {
      me: {
        useQuery: () => ({
          data: mockActor,
          isLoading: false,
          refetch: jest.fn(),
        }),
      },
    },
  },
}));
jest.mock("../queryClient", () => ({
  resetMeetingSessionQueries: () => mockReset(),
}));
jest.mock("../services/analytics", () => ({
  identifyUser: jest.fn(),
  resetAnalyticsIdentity: jest.fn(),
}));
function Probe() {
  const auth = useAuth();
  return (
    <div data-testid="gate">
      {auth.protectedQueriesReady ? "ready" : "blocked"}
    </div>
  );
}
test("blocks immediately across A/B/A and ignores older reset completion, then gates logout", async () => {
  const finishes: Array<() => void> = [];
  mockReset.mockImplementation(
    () => new Promise<void>((resolve) => finishes.push(resolve)),
  );
  const view = render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  expect(screen.getByTestId("gate")).toHaveTextContent("blocked");
  await act(async () => finishes[0]());
  expect(screen.getByTestId("gate")).toHaveTextContent("ready");
  mockActor = { id: "b", username: "b", avatar: null };
  view.rerender(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  expect(screen.getByTestId("gate")).toHaveTextContent("blocked");
  mockActor = { id: "a", username: "a", avatar: null };
  view.rerender(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await act(async () => finishes[1]());
  expect(screen.getByTestId("gate")).toHaveTextContent("blocked");
  await act(async () => finishes[2]());
  expect(screen.getByTestId("gate")).toHaveTextContent("ready");
  sessionStorage.setItem(
    "chronote-ask-run:a:server:conversation",
    JSON.stringify({ runId: "run" }),
  );
  sessionStorage.setItem("unrelated", "keep");
  mockActor = null;
  view.rerender(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  expect(screen.getByTestId("gate")).toHaveTextContent("blocked");
  expect(
    sessionStorage.getItem("chronote-ask-run:a:server:conversation"),
  ).toBeNull();
  expect(sessionStorage.getItem("unrelated")).toBe("keep");
});
