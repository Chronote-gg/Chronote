import "@testing-library/jest-dom";
import { screen } from "@testing-library/react";
import {
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
  setRouteSearch,
} from "./testUtils";
import Library from "../../src/frontend/pages/Library";

beforeEach(() => {
  resetFrontendMocks();
  setRouteParams({ serverId: "legacy-server" });
});

test("legacy Library replaces its history entry with the selected Meetings source", () => {
  renderWithMantine(<Library />);
  const redirect = screen.getByTestId("navigate");
  expect(redirect).toHaveAttribute("data-to", "/portal/meetings");
  expect(redirect).toHaveAttribute("data-replace", "true");
  expect(JSON.parse(redirect.getAttribute("data-search") ?? "{}")).toEqual({
    scope: "guild",
    serverId: "legacy-server",
    attended: false,
    range: "all",
    archive: "active",
  });
});

test("legacy Library preserves the exact detail, event and fullscreen selection", () => {
  setRouteSearch({
    meetingId: "channel#2025-01-01",
    eventId: "event-2",
    fullScreen: true,
  });
  renderWithMantine(<Library />);
  expect(
    JSON.parse(
      screen.getByTestId("navigate").getAttribute("data-search") ?? "{}",
    ),
  ).toMatchObject({
    meetingId: "channel#2025-01-01",
    meetingServerId: "legacy-server",
    eventId: "event-2",
    fullScreen: true,
  });
});

test("a legacy Library URL without a meeting clears orphaned drawer state", () => {
  setRouteSearch({ eventId: "orphan", fullScreen: true });
  renderWithMantine(<Library />);
  const search = JSON.parse(
    screen.getByTestId("navigate").getAttribute("data-search") ?? "{}",
  );
  expect(search).not.toHaveProperty("meetingId");
  expect(search).not.toHaveProperty("eventId");
  expect(search).not.toHaveProperty("fullScreen");
});
