import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithMantine, resetFrontendMocks } from "./testUtils";
import { guildState, navigateSpy } from "./testUtils";
import { usePortalStore } from "../../src/frontend/stores/portalStore";
import ServerSelect from "../../src/frontend/pages/ServerSelect";

describe("ServerSelect page", () => {
  beforeEach(() => {
    resetFrontendMocks();
    usePortalStore.setState({ lastServerId: null });
    window.localStorage.clear();
  });

  test("shows loading state", () => {
    guildState.loading = true;
    renderWithMantine(<ServerSelect />);
    expect(screen.getByText(/Loading your servers/i)).toBeInTheDocument();
  });

  test("shows empty state when no guilds are available", () => {
    guildState.loading = false;
    guildState.guilds = [];
    renderWithMantine(<ServerSelect />);
    expect(screen.getByText(/No servers found/i)).toBeInTheDocument();
  });

  test("selects a server and navigates to library", () => {
    guildState.loading = false;
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    renderWithMantine(<ServerSelect />);

    expect(
      screen.getByText("Choose a server to continue."),
    ).toBeInTheDocument();
    expect(screen.getByText("Servers you manage")).toBeInTheDocument();
    expect(screen.queryByText("View-only servers")).toBeNull();

    fireEvent.click(screen.getByTestId("server-open"));

    expect(guildState.setSelectedGuildId).toHaveBeenCalledWith("g1");
    expect(usePortalStore.getState().lastServerId).toBe("g1");
    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/portal/meetings",
      search: expect.objectContaining({ scope: "guild", serverId: "g1" }),
    });
  });

  test("navigates view-only servers to shared threads route", () => {
    guildState.loading = false;
    guildState.guilds = [{ id: "g2", name: "Guild Two", canManage: false }];
    renderWithMantine(<ServerSelect />);

    expect(screen.getByText("View-only servers")).toBeInTheDocument();
    expect(screen.queryByText("Servers you manage")).toBeNull();

    fireEvent.click(screen.getByTestId("server-open"));

    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/portal/meetings",
      search: expect.objectContaining({ scope: "guild", serverId: "g2" }),
    });
  });

  test("shows both sections when mixed access", () => {
    guildState.loading = false;
    guildState.guilds = [
      { id: "g1", name: "Guild One", canManage: true },
      { id: "g2", name: "Guild Two", canManage: false },
    ];
    renderWithMantine(<ServerSelect />);

    expect(screen.getByText("Servers you manage")).toBeInTheDocument();
    expect(screen.getByText("View-only servers")).toBeInTheDocument();
  });
});
