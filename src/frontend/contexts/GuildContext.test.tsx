import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { GuildProvider, useGuildContext } from "./GuildContext";

const mockAuth = jest.fn();
const mockGuildQuery = jest.fn();
jest.mock("./AuthContext", () => ({ useAuth: () => mockAuth() }));
jest.mock("../services/trpc", () => ({
  trpc: { servers: { listEligible: { useQuery: () => mockGuildQuery() } } },
}));

function DirectServerSelection() {
  const { selectedGuildId, setSelectedGuildId } = useGuildContext();
  useEffect(() => {
    setSelectedGuildId("direct");
  }, [setSelectedGuildId]);
  return <output>{selectedGuildId ?? "none"}</output>;
}

beforeEach(() => {
  localStorage.clear();
  mockAuth.mockReturnValue({ state: "authenticated" });
  mockGuildQuery.mockReturnValue({
    data: { guilds: [{ id: "other", name: "Other", canManage: true }] },
    error: null,
    isLoading: false,
    refetch: jest.fn(),
  });
});

it("allows a direct route selection when guild discovery fails", () => {
  mockGuildQuery.mockReturnValue({
    data: undefined,
    error: new Error("Discovery unavailable"),
    isLoading: false,
    refetch: jest.fn(),
  });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(
      <GuildProvider>
        <DirectServerSelection />
      </GuildProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("direct");
    expect(localStorage.getItem("mn-selected-guild")).toBe("direct");
  } finally {
    log.mockRestore();
  }
});

it.each(["authenticated", "unauthenticated"])(
  "does not reassert an unavailable server for an %s user",
  (state) => {
    mockAuth.mockReturnValue({ state });
    render(
      <GuildProvider>
        <DirectServerSelection />
      </GuildProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("none");
    expect(localStorage.getItem("mn-selected-guild")).toBeNull();
  },
);
