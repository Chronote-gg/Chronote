import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import "./mocks/trpc";
import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { screen, waitFor } from "@testing-library/react";
import PortalLayout from "../../src/frontend/layouts/PortalLayout";
import PortalServerLayout from "../../src/frontend/layouts/PortalServerLayout";
import { usePortalStore } from "../../src/frontend/stores/portalStore";
import {
  authState,
  guildState,
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
  setRouterPathname,
} from "./testUtils";

describe("portal layouts", () => {
  beforeEach(() => {
    localStorage.clear();
    usePortalStore.setState({ lastServerId: null });
    resetFrontendMocks();
  });

  test("PortalLayout shows sign-in prompt for unauthenticated users", () => {
    authState.state = "unauthenticated";
    setRouterPathname("/portal/server/g1/library");
    renderWithMantine(<PortalLayout />);
    expect(screen.queryByTestId("navigate")).toBeNull();
    const cta = screen.getByRole("link", { name: /connect discord/i });
    expect(cta).toHaveAttribute("href", authState.loginUrl);
  });

  test("PortalLayout shows loading state while auth is loading", () => {
    authState.state = "authenticated";
    authState.loading = true;
    guildState.loading = false;
    setRouterPathname("/portal/server/g1/ask");
    renderWithMantine(<PortalLayout />);
    expect(screen.getByText("Loading your portal...")).toBeInTheDocument();
  });

  test("PortalLayout renders navbar and outlet when authenticated", () => {
    authState.state = "authenticated";
    authState.loading = false;
    guildState.loading = false;
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setRouterPathname("/portal/server/g1/library");
    renderWithMantine(<PortalLayout />);
    expect(screen.getByTestId("nav-meetings")).toBeInTheDocument();
    expect(screen.getByTestId("router-outlet")).toBeInTheDocument();
  });

  test("PortalLayout hides navbar on server select route", () => {
    authState.state = "authenticated";
    authState.loading = false;
    guildState.loading = false;
    setRouterPathname("/portal/select-server");
    renderWithMantine(<PortalLayout />);
    expect(screen.queryByTestId("nav-meetings")).toBeNull();
  });

  test("PortalServerLayout returns null while loading", () => {
    authState.state = "authenticated";
    guildState.loading = true;
    setRouteParams({ serverId: "g1" });
    renderWithMantine(<PortalServerLayout />);
    expect(screen.queryByTestId("router-outlet")).toBeNull();
    expect(screen.queryByTestId("navigate")).toBeNull();
  });

  test("PortalServerLayout redirects when server is missing", async () => {
    authState.state = "authenticated";
    guildState.loading = false;
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setRouteParams({ serverId: "g2" });
    renderWithMantine(<PortalServerLayout />);
    await waitFor(() => {
      const nav = screen.getByTestId("navigate");
      expect(nav).toHaveAttribute("data-to", "/portal/select-server");
    });
  });

  test("PortalServerLayout syncs selected guild and last server", async () => {
    authState.state = "authenticated";
    guildState.loading = false;
    guildState.selectedGuildId = null;
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setRouteParams({ serverId: "g1" });

    renderWithMantine(<PortalServerLayout />);
    await waitFor(() => {
      expect(guildState.setSelectedGuildId).toHaveBeenCalledWith("g1");
    });
    await waitFor(() => {
      expect(usePortalStore.getState().lastServerId).toBe("g1");
    });
  });
});
