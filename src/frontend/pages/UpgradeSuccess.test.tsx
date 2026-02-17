import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import UpgradeSuccess, {
  resolveBillingPath,
  resolveOpenPortalPath,
} from "./UpgradeSuccess";

const mockUseSearch = jest.fn();
const mockUseAuth = jest.fn();
const mockUseGuildContext = jest.fn();
const mockNavigate = jest.fn();

jest.mock("@tanstack/react-router", () => ({
  ...jest.requireActual("@tanstack/react-router"),
  useSearch: () => mockUseSearch(),
  useNavigate: () => mockNavigate,
}));

jest.mock("../contexts/AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("../contexts/GuildContext", () => ({
  useGuildContext: () => mockUseGuildContext(),
}));

const renderUpgradeSuccess = () =>
  render(
    <MantineProvider>
      <UpgradeSuccess />
    </MantineProvider>,
  );

describe("UpgradeSuccess", () => {
  beforeEach(() => {
    mockUseSearch.mockReturnValue({
      promo: "SAVE20",
      serverId: "s1",
      plan: "pro",
      interval: "year",
    });
    mockUseAuth.mockReturnValue({ state: "authenticated", loading: false });
    mockUseGuildContext.mockReturnValue({
      guilds: [{ id: "s1", name: "Engineering HQ", canManage: true }],
    });
  });

  afterEach(() => {
    mockUseSearch.mockReset();
    mockUseAuth.mockReset();
    mockUseGuildContext.mockReset();
    mockNavigate.mockReset();
  });

  it("navigates open server and billing actions to the upgraded server", async () => {
    const user = userEvent.setup();
    renderUpgradeSuccess();

    await user.click(
      screen.getByRole("button", { name: "Open Engineering HQ" }),
    );
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/portal/server/s1/library",
    });

    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/portal/server/s1/billing",
    });
  });
});

describe("resolveOpenPortalPath", () => {
  it("returns library path when server is manageable", () => {
    expect(
      resolveOpenPortalPath("s1", [
        { id: "s1", name: "Engineering HQ", canManage: true },
      ]),
    ).toBe("/portal/server/s1/library");
  });

  it("returns ask path when server exists but user cannot manage", () => {
    expect(
      resolveOpenPortalPath("s1", [
        { id: "s1", name: "Engineering HQ", canManage: false },
      ]),
    ).toBe("/portal/server/s1/ask");
  });

  it("returns ask path when server id is present but guild is missing", () => {
    expect(resolveOpenPortalPath("s1", [])).toBe("/portal/server/s1/ask");
  });

  it("falls back to select-server when no server is present", () => {
    expect(resolveOpenPortalPath("", [])).toBe("/portal/select-server");
  });
});

describe("resolveBillingPath", () => {
  it("returns server billing page when server id exists", () => {
    expect(resolveBillingPath("s1")).toBe("/portal/server/s1/billing");
  });

  it("falls back to select-server when server id is missing", () => {
    expect(resolveBillingPath("")).toBe("/portal/select-server");
  });
});
