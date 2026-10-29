import "./mocks/trpc";
import { MantineProvider } from "@mantine/core";
import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import React from "react";
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import Join from "../../src/frontend/pages/Join";
import { trpc } from "../../src/frontend/services/trpc";
import type { FirstMeetingState } from "../../src/types/firstMeeting";
import {
  authState,
  renderWithMantine,
  resetFrontendMocks,
  setRouteSearch,
} from "./testUtils";
import { getRouteSearch } from "./mocks/routerState";
import { setGuildQuery } from "./mocks/trpc";

const serverId = "111111111111111111";
const otherServerId = "222222222222222222";
const historyId = "333333333333333333#2026-10-19T12:00:00.000Z";
const meeting = {
  historyId,
  title: "Permitted meeting",
  portalUrl: `https://chronote.gg/portal/meetings/${serverId}/${encodeURIComponent(historyId)}`,
  discordUrl: `https://discord.com/channels/${serverId}/444444444444444444/555555555555555555`,
  captureNotice: "Some audio could not be captured.",
  recoveryNotice: "Recording recovered after an interruption.",
};
const refetch = jest.fn(async () => undefined);
let result: {
  data: FirstMeetingState | undefined;
  error: { data?: { code: string }; message: string } | null;
  isLoading: boolean;
  isSuccess: boolean;
  isPlaceholderData: boolean;
};
const useFirstMeetingQuery = jest.fn(() => ({ ...result, refetch }));
Object.assign(trpc.meetings, {
  firstMeeting: { useQuery: useFirstMeetingQuery },
});
const verifyServer = () => {
  authState.state = "authenticated";
  setGuildQuery({
    data: {
      guilds: [
        { id: serverId, name: "Member server", canManage: false },
        { id: otherServerId, name: "Other server", canManage: true },
      ],
    },
  });
  setRouteSearch({ serverId });
};

function showTransientError(view: ReturnType<typeof renderWithMantine>) {
  result = {
    ...result,
    error: { message: "Network unavailable" },
    isSuccess: false,
  };
  view.rerender(
    <MantineProvider>
      <Join />
    </MantineProvider>,
  );
}

describe("Join page", () => {
  beforeEach(() => {
    resetFrontendMocks();
    refetch.mockClear();
    useFirstMeetingQuery.mockClear();
    result = {
      data: { kind: "guide" },
      error: null,
      isLoading: false,
      isSuccess: true,
      isPlaceholderData: false,
    };
  });

  test("successful guide explains which meetings are checked", () => {
    verifyServer();
    renderWithMantine(<Join />);
    expect(
      screen.getByText("No accessible recent meeting found yet."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(screen.queryByText(meeting.title)).toBeNull();
  });

  test("unknown_server_stays_generic", () => {
    authState.state = "authenticated";
    setRouteSearch({ serverId });
    renderWithMantine(<Join />);
    expect(screen.getByRole("link", { name: "Open Discord" })).toHaveAttribute(
      "href",
      "https://discord.com/channels/@me",
    );
    expect(screen.getByRole("link", { name: "Open portal" })).toHaveAttribute(
      "href",
      "/portal",
    );
    expect(screen.queryByText(meeting.title)).toBeNull();
    expect(useFirstMeetingQuery).not.toHaveBeenCalled();
  });

  test("normal_member_can_choose_server", () => {
    verifyServer();
    setRouteSearch({ serverId: undefined });
    renderWithMantine(<Join />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a server" }));
    fireEvent.click(screen.getByText("Member server"));
    expect(screen.getByRole("link", { name: "Open Discord" })).toHaveAttribute(
      "href",
      `https://discord.com/channels/${serverId}`,
    );
    expect(screen.getByRole("link", { name: "Open portal" })).toHaveAttribute(
      "href",
      `/portal/meetings?scope=guild&serverId=${serverId}`,
    );
  });

  test("pins_meeting_and_ignores_old_server_response", async () => {
    verifyServer();
    result.data = { kind: "recording", meeting };
    const view = renderWithMantine(<Join />);
    await waitFor(() =>
      expect(getRouteSearch()).toHaveProperty("historyId", historyId),
    );
    expect(
      screen.getByRole("link", { name: "View recording" }),
    ).toHaveAttribute("href", meeting.discordUrl);
    result = { ...result, data: undefined, isSuccess: false, isLoading: true };
    act(() =>
      setRouteSearch({ serverId: otherServerId, historyId: undefined }),
    );
    view.rerender(
      <MantineProvider>
        <Join />
      </MantineProvider>,
    );
    expect(screen.queryByText(meeting.title)).toBeNull();
    expect(screen.queryByRole("link", { name: "View recording" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open portal" })).toHaveAttribute(
      "href",
      `/portal/meetings?scope=guild&serverId=${otherServerId}`,
    );
  });

  test("status_error_keeps_verified_result", async () => {
    verifyServer();
    result.data = { kind: "ready", meeting };
    const view = renderWithMantine(<Join />);
    expect(screen.getByRole("link", { name: "Open meeting" })).toHaveAttribute(
      "href",
      meeting.portalUrl,
    );
    showTransientError(view);
    expect(screen.getByText(/Status unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open meeting" })).toHaveAttribute(
      "href",
      meeting.portalUrl,
    );
    expect(screen.getByText(meeting.captureNotice)).toBeInTheDocument();
    expect(screen.getByText(meeting.recoveryNotice)).toBeInTheDocument();
  });

  test("transient errors remove live claims and controls but preserve verified warnings", () => {
    verifyServer();
    result.data = { kind: "recording", meeting };
    const view = renderWithMantine(<Join />);
    showTransientError(view);
    expect(screen.queryByText("Recording in progress")).toBeNull();
    expect(screen.queryByRole("link", { name: "View recording" })).toBeNull();
    expect(screen.getByText(meeting.captureNotice)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test("transient errors preserve a verified delivery warning", () => {
    verifyServer();
    result.data = { kind: "delivery_attention", delivery: "failed", meeting };
    const view = renderWithMantine(<Join />);
    showTransientError(view);
    expect(
      screen.getByText("Notes saved. Discord delivery failed."),
    ).toBeInTheDocument();
  });

  test("a changed explicit target cannot display a previous meeting", () => {
    verifyServer();
    result.data = { kind: "ready", meeting };
    const view = renderWithMantine(<Join />);
    result = { ...result, data: undefined, isSuccess: false, isLoading: true };
    act(() => setRouteSearch({ historyId: "999999999999999999#other" }));
    view.rerender(
      <MantineProvider>
        <Join />
      </MantineProvider>,
    );
    expect(screen.queryByText(meeting.title)).toBeNull();
    expect(screen.queryByRole("link", { name: "Open meeting" })).toBeNull();
  });

  test.each(["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"])(
    "permission loss or missing target clears protected display: %s",
    (code) => {
      verifyServer();
      result.data = { kind: "ready", meeting };
      const view = renderWithMantine(<Join />);
      result = {
        ...result,
        error: { data: { code }, message: "Private details must not render" },
        isSuccess: false,
      };
      view.rerender(
        <MantineProvider>
          <Join />
        </MantineProvider>,
      );
      expect(screen.queryByRole("link", { name: "Open meeting" })).toBeNull();
      expect(screen.queryByText(meeting.title)).toBeNull();
      expect(screen.queryByText("Private details must not render")).toBeNull();
    },
  );

  test("no bot or private direct target does not substitute another meeting", () => {
    verifyServer();
    setRouteSearch({ historyId });
    result = {
      ...result,
      data: undefined,
      error: { data: { code: "FORBIDDEN" }, message: "No bot" },
      isSuccess: false,
    };
    renderWithMantine(<Join />);
    expect(
      screen.getByText(/This meeting or server is unavailable/),
    ).toBeInTheDocument();
    expect(getRouteSearch()).toHaveProperty("historyId", historyId);
    expect(screen.queryByRole("link", { name: "Open meeting" })).toBeNull();
  });

  test("loading progress retains public instructions", () => {
    verifyServer();
    result = { ...result, data: undefined, isSuccess: false, isLoading: true };
    renderWithMantine(<Join />);
    expect(screen.getByText("Join a voice channel.")).toBeInTheDocument();
    expect(screen.getByTestId("sample-summary")).toBeInTheDocument();
  });

  test.each([
    [{ kind: "recording", meeting }, "Recording in progress"],
    [{ kind: "processing", meeting }, "Preparing your notes"],
    [{ kind: "ready", meeting }, "Your notes are ready"],
    [{ kind: "saved", meeting }, "Notes saved"],
    [
      { kind: "delivery_attention", delivery: "partial", meeting },
      "Notes saved. Some notes could not be posted to Discord.",
    ],
    [
      { kind: "delivery_attention", delivery: "failed", meeting },
      "Notes saved. Discord delivery failed.",
    ],
    [
      { kind: "attention", reason: "interrupted", meeting },
      "Recording interrupted",
    ],
    [
      { kind: "attention", reason: "no_notes", meeting },
      "No notes were generated",
    ],
    [
      { kind: "attention", reason: "processing_failed", meeting },
      "Notes processing failed",
    ],
    [
      { kind: "attention", reason: "status_unknown", meeting },
      "Meeting status unavailable",
    ],
  ] satisfies Array<[FirstMeetingState, string]>)(
    "renders verified state %s",
    (data, copy) => {
      verifyServer();
      result.data = data;
      renderWithMantine(<Join />);
      expect(screen.getByText(copy)).toBeInTheDocument();
    },
  );

  test("optional setup stays collapsed and recording reminder is removed", () => {
    renderWithMantine(<Join />);
    expect(
      screen.getByText("Optional setup").closest("details"),
    ).not.toHaveAttribute("open");
    expect(screen.queryByText(/Let everyone know/)).toBeNull();
    expect(
      screen.getByText("Example notes \u00b7 Fictional meeting"),
    ).toBeInTheDocument();
  });
});
