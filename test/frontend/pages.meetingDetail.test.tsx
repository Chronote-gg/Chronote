import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { screen, waitFor } from "@testing-library/react";
import {
  guildState,
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
  setRouterPathname,
} from "./testUtils";
import { setMeetingsDetailQuery } from "./mocks/trpc";
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

  test("renders a direct meeting detail route without a selected server", async () => {
    guildState.guilds = [];
    setMeetingsDetailQuery({
      data: {
        meeting: {
          id: meetingId,
          meetingId: "meeting-1",
          channelId: "voice-1",
          channelName: "Private sync",
          timestamp: "2026-01-02T00:00:00.000Z",
          duration: 3600,
          tags: ["planning"],
          notes: "Summary: private planning sync",
          summarySentence: "Private planning sync.",
          summaryLabel: "Private sync",
          audioUrl: null,
          attendees: ["User A", "User B"],
          events: [],
        },
      },
    });

    renderWithMantine(<MeetingDetail />);

    expect(screen.getByTestId("meeting-detail-page")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This meeting may belong to a server you no longer browse directly.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("Private sync").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Full transcript")).toBeInTheDocument();
  });

  test("shows access errors from the meeting detail query", async () => {
    setMeetingsDetailQuery({
      data: { meeting: null },
      error: new Error("Meeting access required."),
    });

    renderWithMantine(<MeetingDetail />);

    await waitFor(() => {
      expect(screen.getByText("Meeting access required.")).toBeInTheDocument();
    });
  });
});
