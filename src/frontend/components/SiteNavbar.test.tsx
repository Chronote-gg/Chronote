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

const renderNavbar = () =>
  render(
    <MantineProvider>
      <SiteNavbar pathname="/portal/meetings" />
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
});
