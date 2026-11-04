import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { screen } from "@testing-library/react";
import {
  guildState,
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
  setRouterPathname,
  setRouteSearch,
} from "./testUtils";
import PortalServerLayout from "../../src/frontend/layouts/PortalServerLayout";
import MeetingDetail from "../../src/frontend/pages/MeetingDetail";

const meetingId = "voice-1#2026-01-02T00:00:00.000Z";

describe("MeetingDetail page", () => {
  beforeEach(() => {
    resetFrontendMocks();
    setRouteParams({ serverId: "guild-1", meetingId });
    setRouterPathname(
      `/portal/meetings/guild-1/${encodeURIComponent(meetingId)}`,
    );
  });

  test("replaces a direct record URL with an All-source drawer link", () => {
    setRouteSearch({ eventId: "event", fullScreen: true });
    renderWithMantine(<MeetingDetail />);
    const redirect = screen.getByTestId("navigate");
    expect(redirect).toHaveAttribute("data-to", "/portal/meetings");
    expect(redirect).toHaveAttribute("data-replace", "true");
    expect(JSON.parse(redirect.getAttribute("data-search") ?? "null")).toEqual(
      expect.objectContaining({
        scope: "all",
        meetingServerId: "guild-1",
        meetingId,
        eventId: "event",
        fullScreen: true,
      }),
    );
  });
});
describe("legacy Library destination", () => {
  beforeEach(resetFrontendMocks);
  test.each([
    { guilds: [] },
    { guilds: [{ id: "other", name: "Another server" }] },
  ])(
    "replaces the legacy URL before membership redirect for %j",
    ({ guilds }) => {
      guildState.guilds = guilds;
      setRouteParams({ serverId: "retained" });
      setRouterPathname("/portal/server/retained/library");
      setRouteSearch({
        meetingId: "voice#date",
        eventId: "e",
        fullScreen: true,
      });
      renderWithMantine(<PortalServerLayout />);
      const redirect = screen.getByTestId("navigate");
      expect(redirect).toHaveAttribute("data-to", "/portal/meetings");
      expect(redirect).toHaveAttribute("data-replace", "true");
      expect(
        JSON.parse(redirect.getAttribute("data-search") ?? "null"),
      ).toEqual({
        scope: "guild",
        serverId: "retained",
        attended: false,
        range: "all",
        archive: "active",
        meetingServerId: "retained",
        meetingId: "voice#date",
        eventId: "e",
        fullScreen: true,
      });
    },
  );
});
