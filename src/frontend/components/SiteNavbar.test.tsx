import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SiteNavbar, { SiteNavbarView } from "./SiteNavbar";
import { useAuth } from "../contexts/AuthContext";
import { useGuildContext } from "../contexts/GuildContext";

const navigateMock = jest.fn();
let browseSearch: Record<string, unknown> = {};

jest.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useSearch: () => browseSearch,
}));

jest.mock("../contexts/AuthContext", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../contexts/GuildContext", () => ({
  useGuildContext: jest.fn(),
}));

const renderNavbar = (pathname = "/portal/meetings") =>
  render(
    <MantineProvider>
      <SiteNavbar pathname={pathname} />
    </MantineProvider>,
  );

describe("SiteNavbar", () => {
  const openMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    browseSearch = {};
    jest.mocked(useAuth).mockReturnValue({
      state: "authenticated",
      loading: false,
      protectedQueriesReady: true,
      loginUrl: "/auth/discord",
      logoutUrl: "/logout",
      user: {
        id: "user-1",
        username: "User 1",
        avatar: null,
      },
      refresh: jest.fn(async () => undefined),
    });
    jest.mocked(useGuildContext).mockReturnValue({
      guilds: [],
      selectedGuildId: null,
      setSelectedGuildId: jest.fn(),
      loading: false,
      error: null,
      refresh: jest.fn(async () => undefined),
    });
    Object.defineProperty(window, "open", {
      value: openMock,
      configurable: true,
    });
  });

  it("opens support as an email link", () => {
    renderNavbar();

    fireEvent.click(screen.getByTestId("nav-support"));

    expect(openMock).toHaveBeenCalledWith(
      "mailto:basic@basicbit.net?subject=Chronote%20support",
      "_blank",
    );
  });

  it("opens personal settings from a global nav item", () => {
    renderNavbar();

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Server")).toBeInTheDocument();
    expect(screen.getByText("Help")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("nav-personal-settings"));

    expect(navigateMock).toHaveBeenCalledWith({ to: "/portal/settings" });
  });

  it("labels server settings separately from personal settings", () => {
    jest.mocked(useGuildContext).mockReturnValue({
      guilds: [{ id: "guild-1", name: "Guild 1", canManage: true }],
      selectedGuildId: "guild-1",
      setSelectedGuildId: jest.fn(),
      loading: false,
      error: null,
      refresh: jest.fn(async () => undefined),
    });

    renderNavbar("/portal/server/guild-1/settings");

    expect(screen.getByText("Personal Settings")).toBeInTheDocument();
    expect(screen.getByText("Server Settings")).toBeInTheDocument();
  });

  it("keeps manager-only server links visible with permission context", () => {
    jest.mocked(useGuildContext).mockReturnValue({
      guilds: [{ id: "guild-1", name: "Guild 1", canManage: false }],
      selectedGuildId: "guild-1",
      setSelectedGuildId: jest.fn(),
      loading: false,
      error: null,
      refresh: jest.fn(async () => undefined),
    });

    renderNavbar("/portal/server/guild-1/ask");

    expect(screen.getByText("Guild 1")).toBeInTheDocument();
    expect(screen.getAllByText("Requires Manage Server").length).toBe(2);
    expect(screen.getByTestId("nav-billing")).toHaveAttribute(
      "data-disabled",
      "true",
    );
    expect(screen.getByTestId("nav-settings")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });
});

it("uses URL scope instead of stored guild management rights", () => {
  jest.mocked(useAuth).mockReturnValue({
    state: "authenticated",
    loading: false,
    protectedQueriesReady: true,
    loginUrl: "/auth/discord",
    logoutUrl: "/logout",
    user: { id: "user", username: "User", avatar: null },
    refresh: jest.fn(async () => undefined),
  });
  jest.mocked(useGuildContext).mockReturnValue({
    guilds: [
      { id: "manager", name: "Manager server", canManage: true },
      { id: "member", name: "Member server", canManage: false },
    ],
    selectedGuildId: "manager",
    setSelectedGuildId: jest.fn(),
    loading: false,
    error: null,
    refresh: jest.fn(async () => undefined),
  });
  browseSearch = { scope: "guild", serverId: "member" };
  renderNavbar();
  expect(screen.getByText("Meetings")).toBeInTheDocument();
  expect(screen.queryByText("Library")).not.toBeInTheDocument();
  expect(screen.queryByTestId("nav-server-button")).not.toBeInTheDocument();
  expect(screen.getByTestId("nav-billing")).toHaveAttribute(
    "data-disabled",
    "true",
  );
  fireEvent.click(screen.getByTestId("nav-ask"));
  expect(navigateMock).toHaveBeenCalledWith({
    to: "/portal/server/member/ask",
  });
  fireEvent.click(screen.getByRole("button", { name: "All meetings" }));
  expect(navigateMock).toHaveBeenLastCalledWith({
    to: "/portal/meetings",
    search: expect.objectContaining({ scope: "all", attended: false }),
  });
});

it.each<import("../../types/meetingBrowse").MeetingBrowseScope>([
  { kind: "all" },
  { kind: "personal" },
  { kind: "guild", serverId: "previous" },
])("withholds server capabilities for %j", (scope) => {
  const onNavigate = jest.fn();
  render(
    <MantineProvider>
      <SiteNavbarView
        pathname="/portal/meetings"
        authState="authenticated"
        guilds={[{ id: "manager", name: "Manager", canManage: true }]}
        selectedGuildId="manager"
        scope={scope}
        sources={[{ id: "previous", name: "Old server", retainedAccess: true }]}
        onNavigate={onNavigate}
      />
    </MantineProvider>,
  );
  for (const action of ["ask", "billing", "settings"]) {
    fireEvent.click(screen.getByTestId("nav-" + action));
    expect(screen.getByTestId("nav-" + action)).toHaveAttribute(
      "data-disabled",
      "true",
    );
  }
  expect(onNavigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("nav-upload"));
  expect(onNavigate).toHaveBeenLastCalledWith("/portal/upload");
  fireEvent.click(screen.getByTestId("nav-personal-settings"));
  expect(onNavigate).toHaveBeenLastCalledWith("/portal/settings");
});
it("enables manager actions only for the selected source and revokes them on source change", () => {
  const props = {
    pathname: "/portal/meetings",
    authState: "authenticated" as const,
    guilds: [
      { id: "manager", name: "Manager", canManage: true },
      { id: "member", name: "Member", canManage: false },
    ],
    selectedGuildId: "manager",
    onNavigate: jest.fn(),
  };
  const { rerender } = render(
    <MantineProvider>
      <SiteNavbarView
        {...props}
        scope={{ kind: "guild", serverId: "manager" }}
      />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByTestId("nav-billing"));
  expect(props.onNavigate).toHaveBeenCalledWith(
    "/portal/server/manager/billing",
  );
  rerender(
    <MantineProvider>
      <SiteNavbarView
        {...props}
        scope={{ kind: "guild", serverId: "member" }}
      />
    </MantineProvider>,
  );
  expect(screen.getByTestId("nav-billing")).toHaveAttribute(
    "data-disabled",
    "true",
  );
  expect(screen.getByTestId("nav-settings")).toHaveAttribute(
    "data-disabled",
    "true",
  );
});
