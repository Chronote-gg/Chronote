import "@testing-library/jest-dom";
import type {} from "../../src/frontend/router";
import { MantineProvider } from "@mantine/core";
import React from "react";
import { beforeEach, describe, test } from "@jest/globals";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithMantine, resetFrontendMocks } from "./testUtils";
import { guildState } from "./testUtils";
import { resolveNowMs } from "../../src/frontend/utils/now";
import {
  feedbackSubmitSummaryMutation,
  setMeetingsDetailQuery,
  setMeetingsListQuery,
  setServersChannelsQuery,
  meetingsListQuery,
} from "./mocks/trpc";
import PortalServerLayout from "../../src/frontend/layouts/PortalServerLayout";
import Library from "../../src/frontend/pages/Library";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const buildRecentTimestamp = () =>
  new Date(resolveNowMs() - MS_PER_DAY).toISOString();

function expectFilteredLibrary(view: ReturnType<typeof renderWithMantine>) {
  Object.assign(meetingsListQuery, { isSuccess: true });
  view.rerender(
    <MantineProvider>
      <Library />
    </MantineProvider>,
  );
  expect(screen.queryByText("Your first meeting goes here.")).toBeNull();
}

async function renderSelectedMeeting() {
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
        id: "row-1",
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
}

describe("Library page", () => {
  beforeEach(() => {
    resetFrontendMocks();
    Object.assign(meetingsListQuery, {
      isSuccess: true,
      isPlaceholderData: false,
    });
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setServersChannelsQuery({
      data: {
        voiceChannels: [{ id: "c1", name: "General", botAccess: true }],
        textChannels: [{ id: "t1", name: "notes", botAccess: true }],
      },
    });
  });

  test("empty_library_uses_selected_example_layout", () => {
    renderWithMantine(<Library />);
    expect(
      screen.getByText("Your first meeting goes here."),
    ).toBeInTheDocument();
    expect(screen.getByText("Join a voice channel.")).toBeInTheDocument();
    expect(screen.getByText("Start recording.")).toBeInTheDocument();
    expect(screen.getByText("End the recording.")).toBeInTheDocument();
    expect(screen.getAllByTestId("sample-summary")).toHaveLength(1);
    expect(
      screen.getByText("Example notes · Fictional meeting"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Discord" })).toHaveAttribute(
      "href",
      "https://discord.com/channels/g1",
    );
    expect(
      screen.getByText("Optional setup").closest("details"),
    ).not.toHaveAttribute("open");
    expect(screen.queryByTestId("library-search")).toBeNull();
    expect(screen.queryByText(/Sorted by recency/)).toBeNull();
  });

  test("empty library retains its refresh action", () => {
    renderWithMantine(<Library />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  test.each(["loading", "error", "placeholder", "disabled", "unknown server"])(
    "%s is not first use",
    (state) => {
      if (state === "loading") setMeetingsListQuery({ isLoading: true });
      if (state === "error")
        setMeetingsListQuery({ error: new Error("offline") });
      if (state === "placeholder")
        Object.assign(meetingsListQuery, { isPlaceholderData: true });
      if (state === "disabled") guildState.selectedGuildId = null;
      if (state === "unknown server") guildState.guilds = [];
      renderWithMantine(<Library />);
      expect(screen.queryByText("Your first meeting goes here.")).toBeNull();
      expect(screen.getByTestId("library-search")).toBeInTheDocument();
    },
  );

  test("older_unfiltered_row_suppresses_first_use", () => {
    setMeetingsListQuery({
      data: {
        meetings: [
          {
            id: "old",
            meetingId: "old",
            channelId: "c1",
            channelName: "General",
            timestamp: new Date(resolveNowMs() - 60 * MS_PER_DAY).toISOString(),
            duration: 60,
            tags: [],
            notes: "Old notes",
            audioAvailable: false,
            transcriptAvailable: true,
          },
        ],
      },
    });
    renderWithMantine(<Library />);
    expect(screen.queryByText("Your first meeting goes here.")).toBeNull();
    expect(screen.getByTestId("library-search")).toBeInTheDocument();
    expect(
      screen.getByText(/No meetings match these filters yet/i),
    ).toBeInTheDocument();
  });

  test("filtered_empty_is_not_first_meeting", () => {
    Object.assign(meetingsListQuery, { isSuccess: false });
    const view = renderWithMantine(<Library />);
    fireEvent.change(screen.getByTestId("library-search"), {
      target: { value: "not found" },
    });
    expectFilteredLibrary(view);
    expect(
      screen.getByText(/No meetings match these filters yet/i),
    ).toBeInTheDocument();
  });

  test("empty_library_filters_do_not_hide_existing_results", () => {
    Object.assign(meetingsListQuery, { isSuccess: false });
    const view = renderWithMantine(<Library />);
    fireEvent.change(screen.getByTestId("library-range"), {
      target: { value: "Last 7 days" },
    });
    fireEvent.click(screen.getByTestId("library-archive-filter"));
    fireEvent.click(screen.getByRole("option", { name: "Archived" }));
    expectFilteredLibrary(view);
    expect(screen.getByTestId("library-search")).toBeInTheDocument();
  });

  test("renders meeting details for a selected row", async () => {
    await renderSelectedMeeting();
    expect(screen.getByText(/Full transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/Was this summary helpful/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Mark summary helpful/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Mark summary needs work/i),
    ).toBeInTheDocument();
  });

  test("submits summary feedback from the meeting drawer", async () => {
    await renderSelectedMeeting();

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
        meetingId: "row-1",
        rating: "down",
        comment: "Add a few more decision details.",
      });
    });
  });
});
