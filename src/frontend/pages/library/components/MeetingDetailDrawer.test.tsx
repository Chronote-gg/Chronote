import {
  useMeetingDetailMock,
  buildMeeting,
  buildDetail,
  buildUseMeetingDetailResult,
  renderDrawer,
  mockShareStateQuery,
  mockSetPersonalShareGrants,
  mockApplyNotesCorrection,
  mockPreviewTeaching,
  mockNotionStatusQuery,
  mockNotionExportStatusQuery,
  mockNotionExportStatusUseQuery,
  mockPendingDelivery,
  applyCorrection,
  resetDrawerFixtures,
} from "./MeetingDetailDrawer.fixture";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import MeetingDetailDrawer from "./MeetingDetailDrawer";
describe("MeetingDetailDrawer summary copy", () => {
  const writeTextMock = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => resetDrawerFixtures(writeTextMock));

  it("shows unavailable status with a recheck in both drawer layouts while canonical history stays live", async () => {
    const retry = jest.fn();
    const detail = buildDetail({
      status: "in_progress",
      notes: "",
      summarySentence: null,
    });
    const meeting = buildMeeting({
      status: "in_progress",
      notes: "",
      summary: "Notes will appear after the meeting is processed.",
    });
    const result = {
      ...buildUseMeetingDetailResult({ detail, meeting }),
      liveStreamEnabled: true,
      displayStatus: "unavailable" as const,
      liveStream: {
        meeting: null,
        status: "unavailable" as const,
        events: [],
        attendees: [],
        retry,
      },
      timelineEmptyLabel:
        "Recording status cannot be confirmed. Recheck to resume live updates.",
    };
    useMeetingDetailMock.mockReturnValue(result);
    const view = renderDrawer();
    expect(screen.getByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Live transcript")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Notes will appear after the meeting is processed."),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck recording status" }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open fullscreen" })[0],
    );
    expect(
      await screen.findByText(result.timelineEmptyLabel),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recheck recording status" }),
    ).toBeInTheDocument();
    expect(detail.status).toBe("in_progress");
    expect(meeting.status).toBe("in_progress");
    useMeetingDetailMock.mockReturnValue({
      ...result,
      displayStatus: "in_progress",
      liveStream: { ...result.liveStream, status: "live" },
      timelineEmptyLabel: "Waiting for the first transcript line...",
    });
    view.rerender(
      <MantineProvider>
        <MeetingDetailDrawer
          opened
          selectedMeetingId="m1"
          selectedGuildId="g1"
          canManageSelectedGuild
          channelNameMap={new Map([["c1", "general"]])}
          invalidateMeetingLists={jest.fn(async () => {})}
          onClose={jest.fn()}
        />
      </MantineProvider>,
    );
    expect(screen.getByText("Live transcript")).toBeInTheDocument();
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Recheck recording status" }),
    ).not.toBeInTheDocument();
  });
  it("copies summary notes as Markdown", async () => {
    const notesMarkdown = "- Decision: Ship it\n- Action: Follow up";
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ notes: notesMarkdown }),
        meeting: buildMeeting({ notes: notesMarkdown }),
      }),
    );

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Copy summary as Markdown"));

    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith(notesMarkdown),
    );
    expect(notifications.show).toHaveBeenCalledWith({
      color: "green",
      message: "Summary copied to clipboard.",
    });
  });
  it("copied interrupted notes retain the coverage warning", async () => {
    const capture = {
      kind: "interrupted" as const,
      startedAt: "2026-01-01T00:00:00Z",
      detectedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
    };
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ notes: "Generated saved decision.", capture }),
        meeting: buildMeeting({ notes: "Generated saved decision.", capture }),
      }),
    );
    renderDrawer();
    fireEvent.click(screen.getByLabelText("Copy summary as Markdown"));
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining("These notes cover only the saved recording."),
      ),
    );
  });

  it("reinitializes the same meeting after the drawer closes", async () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ meetingName: "Original name" }),
        meeting: buildMeeting({ meetingName: "Original name" }),
      }),
    );
    const view = renderDrawer({ canManageSelectedGuild: true });

    fireEvent.click(screen.getByLabelText("Rename meeting"));
    expect(await screen.findByTestId("meeting-rename-input")).toHaveValue(
      "Original name",
    );
    fireEvent.change(screen.getByTestId("meeting-rename-input"), {
      target: { value: "Stale local draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    useMeetingDetailMock.mockReturnValue({
      ...buildUseMeetingDetailResult(),
      detail: null,
      meeting: null,
    });
    view.rerender(
      <MantineProvider>
        <MeetingDetailDrawer
          opened={false}
          selectedMeetingId={null}
          selectedGuildId="g1"
          canManageSelectedGuild
          channelNameMap={new Map([["c1", "general"]])}
          invalidateMeetingLists={jest.fn(async () => {})}
          onClose={jest.fn()}
        />
      </MantineProvider>,
    );

    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ meetingName: "Updated elsewhere" }),
        meeting: buildMeeting({ meetingName: "Updated elsewhere" }),
      }),
    );
    view.rerender(
      <MantineProvider>
        <MeetingDetailDrawer
          opened
          selectedMeetingId="m1"
          selectedGuildId="g1"
          canManageSelectedGuild
          channelNameMap={new Map([["c1", "general"]])}
          invalidateMeetingLists={jest.fn(async () => {})}
          onClose={jest.fn()}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByLabelText("Rename meeting"));
    expect(await screen.findByTestId("meeting-rename-input")).toHaveValue(
      "Updated elsewhere",
    );
  });

  it("disables copy when no notes are available", () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ notes: "   " }),
      }),
    );

    renderDrawer();
    const copyButton = screen.getByLabelText("Copy summary as Markdown");
    expect(copyButton).toBeDisabled();
  });

  it("passes the processing outcome to the summary panel", () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          notes: "",
          processing: { transcription: "empty", notes: "skipped" },
        }),
        meeting: buildMeeting({
          notes: "",
          processing: { transcription: "empty", notes: "skipped" },
        }),
      }),
    );

    renderDrawer();
    expect(
      screen.getByText(
        "No usable speech was found, so no notes were generated.",
      ),
    ).toBeVisible();
  });

  it("shows server access notices instead of transcript and audio", () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          transcript: "Hidden transcript",
          transcriptAccessEnabled: false,
          audioUrl: "https://example.com/recording.mp3",
          audioAccessEnabled: false,
        }),
        meeting: buildMeeting({
          transcriptAccessEnabled: false,
          audioAccessEnabled: false,
          audioUrl: "https://example.com/recording.mp3",
        }),
      }),
    );

    renderDrawer();

    expect(
      screen.getByText("Transcript access is disabled for this server."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Audio recording access is disabled for this server."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Hidden transcript")).not.toBeInTheDocument();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("disables share button when sharing permission is denied", () => {
    mockShareStateQuery.error = { data: { code: "FORBIDDEN" } };

    renderDrawer();

    expect(screen.getByTestId("meeting-share")).toBeDisabled();
  });

  it("updates explicit personal meeting share grants", async () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          ownershipScope: "personal",
          ownerUserId: "user-1",
          personalShareManageable: true,
        }),
      }),
    );

    renderDrawer();
    fireEvent.click(screen.getByTestId("meeting-share"));
    fireEvent.change(await screen.findByTestId("personal-share-user-ids"), {
      target: { value: "222222222222222222" },
    });
    fireEvent.change(screen.getByTestId("personal-share-guild-ids"), {
      target: { value: "333333333333333333" },
    });
    fireEvent.click(screen.getByTestId("personal-share-save"));

    await waitFor(() =>
      expect(mockSetPersonalShareGrants).toHaveBeenCalledWith({
        serverId: "g1",
        meetingId: "m1",
        userIds: ["222222222222222222"],
        guildIds: ["333333333333333333"],
      }),
    );
  });

  it("shows archive actions for personal meeting owners", () => {
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          ownershipScope: "personal",
          ownerUserId: "user-1",
          personalShareManageable: true,
        }),
      }),
    );

    renderDrawer({
      canManageSelectedGuild: false,
      selectedGuildId: "personal:user-1",
    });

    expect(screen.getByTestId("meeting-archive")).toBeEnabled();
  });

  it("does not query Notion export status when Notion is not configured", () => {
    mockNotionStatusQuery.data = { configured: false, connected: false };

    renderDrawer();

    expect(mockNotionExportStatusUseQuery).toHaveBeenCalledWith(
      { serverId: "g1", meetingId: "m1" },
      { enabled: false },
    );
  });

  it("disables Notion export actions while export status is loading", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = undefined;
    mockNotionExportStatusQuery.isLoading = true;

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(
      (await screen.findByText("Loading Notion status...")).closest("button"),
    ).toBeDisabled();
  });

  it("disables Notion export actions when export status fails", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = undefined;
    mockNotionExportStatusQuery.error = new Error("boom");

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(
      (await screen.findByText("Notion status unavailable")).closest("button"),
    ).toBeDisabled();
  });

  it("shows a retry action for failed automated Notion exports", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = {
      exported: false,
      source: "automation",
      currentNotesVersion: 1,
      outdated: false,
      lastError: "Reconnect Notion.",
    };

    renderDrawer();
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(await screen.findByText("Retry Notion automation")).toBeEnabled();
  });

  it("shows personal Notion retry for the personal meeting owner", async () => {
    mockNotionStatusQuery.data = { configured: true, connected: true };
    mockNotionExportStatusQuery.data = {
      exported: false,
      source: "automation",
      currentNotesVersion: 1,
      outdated: false,
      lastError: "Reconnect Notion.",
    };
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          ownershipScope: "personal",
          ownerUserId: "user-1",
          personalShareManageable: true,
        }),
      }),
    );

    renderDrawer({
      canManageSelectedGuild: false,
      selectedGuildId: "personal:user-1",
    });
    fireEvent.click(screen.getByLabelText("Notes actions"));

    expect(await screen.findByText("Retry Notion automation")).toBeEnabled();
  });

  it("offers an explicit dictionary-teaching step after a manager applies a correction", async () => {
    jest.mocked(notifications.show).mockClear();
    renderDrawer({ canManageSelectedGuild: true });

    await applyCorrection();

    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "notes-correction-teaching-offer",
        title: "Saved. Updating Discord.",
        autoClose: expect.any(Number),
      }),
    );
  });

  it("preserves correction teaching context across a detail refresh", async () => {
    jest.mocked(notifications.show).mockClear();
    const view = renderDrawer({ canManageSelectedGuild: true });

    await applyCorrection();
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({
          notes: "- Decision: Ship it\n- Contact: Jon Smythe",
          notesVersion: 2,
        }),
        meeting: buildMeeting({
          notes: "- Decision: Ship it\n- Contact: Jon Smythe",
        }),
      }),
    );
    view.rerender(
      <MantineProvider>
        <MeetingDetailDrawer
          opened
          selectedMeetingId="m1"
          selectedGuildId="g1"
          canManageSelectedGuild
          channelNameMap={new Map([["c1", "general"]])}
          invalidateMeetingLists={jest.fn(async () => {})}
          onClose={jest.fn()}
        />
      </MantineProvider>,
    );

    const offer = jest
      .mocked(notifications.show)
      .mock.calls.map(([options]) => options)
      .find((options) => options.id === "notes-correction-teaching-offer");
    render(<MantineProvider>{offer?.message}</MantineProvider>);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Teach Chronote from this correction",
      }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Teach Chronote" }),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "It wrote John Smith, but his name is Jon Smythe.",
      ),
    ).toBeInTheDocument();
  });

  it("dismisses a correction teaching offer when the selected meeting changes", async () => {
    jest.mocked(notifications.show).mockClear();
    const view = renderDrawer({ canManageSelectedGuild: true });

    await applyCorrection();
    jest.mocked(notifications.hide).mockClear();
    useMeetingDetailMock.mockReturnValue(
      buildUseMeetingDetailResult({
        detail: buildDetail({ id: "m2", meetingId: "meeting-2" }),
        meeting: buildMeeting({ id: "m2", meetingId: "meeting-2" }),
      }),
    );
    view.rerender(
      <MantineProvider>
        <MeetingDetailDrawer
          opened
          selectedMeetingId="m2"
          selectedGuildId="g1"
          canManageSelectedGuild
          channelNameMap={new Map([["c1", "general"]])}
          invalidateMeetingLists={jest.fn(async () => {})}
          onClose={jest.fn()}
        />
      </MantineProvider>,
    );

    await waitFor(() =>
      expect(notifications.hide).toHaveBeenCalledWith(
        "notes-correction-teaching-offer",
      ),
    );
  });

  it("falls back to instruction-only teaching after correction context expires", async () => {
    const expiresAtMs = Date.now() + 1_000;
    mockApplyNotesCorrection.mockResolvedValueOnce({
      ok: true,
      kind: "saved",
      delivery: mockPendingDelivery,
      dictionaryTeachingContextToken: "11111111-1111-4111-8111-111111111111",
      dictionaryTeachingContextExpiresAtMs: expiresAtMs,
      dictionaryTeachingInstruction:
        "It wrote John Smith, but his name is Jon Smythe.",
    });
    jest.mocked(notifications.show).mockClear();
    renderDrawer({ canManageSelectedGuild: true });

    await applyCorrection();
    const offer = jest
      .mocked(notifications.show)
      .mock.calls.map(([options]) => options)
      .find((options) => options.id === "notes-correction-teaching-offer");
    render(<MantineProvider>{offer?.message}</MantineProvider>);
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(expiresAtMs);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Teach Chronote from this correction",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review terms" }),
    );

    await waitFor(() =>
      expect(mockPreviewTeaching).toHaveBeenCalledWith({
        serverId: "g1",
        instruction: "It wrote John Smith, but his name is Jon Smythe.",
        correctionContextToken: undefined,
        doNotTrack: false,
      }),
    );
    nowSpy.mockRestore();
  });

  it("does not offer dictionary teaching to a member without Manage Server", async () => {
    jest.mocked(notifications.show).mockClear();
    renderDrawer({ canManageSelectedGuild: false });

    await applyCorrection();

    expect(notifications.show).toHaveBeenCalledWith({
      message: "Saved. Updating Discord.",
    });
    expect(notifications.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "notes-correction-teaching-offer" }),
    );
  });
});
