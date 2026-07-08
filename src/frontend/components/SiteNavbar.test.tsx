import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SiteNavbar from "./SiteNavbar";
import { useAuth } from "../contexts/AuthContext";
import { useGuildContext } from "../contexts/GuildContext";

const navigateMock = jest.fn();

jest.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
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
    jest.mocked(useAuth).mockReturnValue({
      state: "authenticated",
      loading: false,
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
});
