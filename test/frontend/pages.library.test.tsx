import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithMantine, resetFrontendMocks } from "./testUtils";
import { guildState } from "./testUtils";
import { resolveNowMs } from "../../src/frontend/utils/now";
import {
  feedbackSubmitSummaryMutation,
  setMeetingsDetailQuery,
  setMeetingsListQuery,
  setServersChannelsQuery,
} from "./mocks/trpc";
import PortalServerLayout from "../../src/frontend/layouts/PortalServerLayout";
import Library from "../../src/frontend/pages/Library";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const buildRecentTimestamp = () =>
  new Date(resolveNowMs() - MS_PER_DAY).toISOString();

describe("Library page", () => {
  beforeEach(() => {
    resetFrontendMocks();
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setServersChannelsQuery({
      data: {
        voiceChannels: [{ id: "c1", name: "General", botAccess: true }],
        textChannels: [{ id: "t1", name: "notes", botAccess: true }],
      },
    });
  });

  test("shows empty state when no meetings match filters", () => {
    setMeetingsListQuery({
      data: { meetings: [] },
      isLoading: false,
      error: null,
    });
    renderWithMantine(
      <>
        <PortalServerLayout />
        <Library />
      </>,
    );
    expect(screen.getByTestId("library-refresh-top")).toBeInTheDocument();
    expect(
      screen.getByText(/No meetings match these filters yet/i),
    ).toBeInTheDocument();
  });

  test("renders meeting details for a selected row", async () => {
    const meetingTimestamp = buildRecentTimestamp();
    setMeetingsListQuery({
      data: {
        meetings: [
          {
            id: "row-1",
            meetingId: "m1",
            channelId: "c1",
            channelName: "General",
            timestamp: meetingTimestamp,
            duration: 3600,
            tags: ["alpha"],
            notes: "Summary: Weekly sync",
            summarySentence: "Weekly sync summary",
            summaryLabel: "Highlights",
            audioAvailable: false,
            transcriptAvailable: true,
          },
        ],
      },
    });
    setMeetingsDetailQuery({
      data: {
        meeting: {
          id: "detail-1",
          meetingId: "m1",
          channelId: "c1",
          timestamp: meetingTimestamp,
          duration: 3600,
          tags: ["alpha"],
          notes: "Summary: Weekly sync",
          summarySentence: null,
          summaryLabel: null,
          audioUrl: null,
          attendees: [],
          events: [],
        },
      },
    });
    renderWithMantine(
      <>
        <PortalServerLayout />
        <Library />
      </>,
    );

    fireEvent.click(screen.getByTestId("library-meeting-row"));

    await waitFor(() => {
      expect(screen.getByText(/Audio isn/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Full transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/Was this summary helpful/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mark summary helpful/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Mark summary needs work/i),
    ).toBeInTheDocument();
  });

  test("submits summary feedback from the meeting drawer", async () => {
    const meetingTimestamp = buildRecentTimestamp();
    setMeetingsListQuery({
      data: {
        meetings: [
          {
            id: "row-1",
            meetingId: "m1",
            channelId: "c1",
            channelName: "General",
            timestamp: meetingTimestamp,
            duration: 3600,
            tags: ["alpha"],
            notes: "Summary: Weekly sync",
            summarySentence: "Weekly sync summary",
            summaryLabel: "Highlights",
            audioAvailable: false,
            transcriptAvailable: true,
          },
        ],
      },
    });
    setMeetingsDetailQuery({
      data: {
        meeting: {
          id: "detail-1",
          meetingId: "m1",
          channelId: "c1",
          timestamp: meetingTimestamp,
          duration: 3600,
          tags: ["alpha"],
          notes: "Summary: Weekly sync",
          summarySentence: null,
          summaryLabel: null,
          audioUrl: null,
          attendees: [],
          events: [],
        },
      },
    });
    renderWithMantine(
      <>
        <PortalServerLayout />
        <Library />
      </>,
    );

    fireEvent.click(screen.getByTestId("library-meeting-row"));

    await waitFor(() => {
      expect(screen.getByText(/Audio isn/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Mark summary needs work/i));

    await waitFor(() => {
      expect(screen.getByText(/Summary feedback/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/What could be better/i), {
      target: { value: "Add a few more decision details." },
    });
    fireEvent.click(screen.getByText(/Send feedback/i));

    await waitFor(() => {
      expect(feedbackSubmitSummaryMutation.mutateAsync).toHaveBeenCalledWith({
        serverId: "g1",
        meetingId: "detail-1",
        rating: "down",
        comment: "Add a few more decision details.",
      });
    });
  });
});
