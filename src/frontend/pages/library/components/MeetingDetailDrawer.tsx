import { useEffect, useState } from "react";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import type { HTMLAttributes } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  useComputedColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFilter, IconPencil, IconUsers } from "@tabler/icons-react";
import MeetingTimeline, {
  MEETING_TIMELINE_FILTERS,
} from "../../../components/MeetingTimeline";
import Surface from "../../../components/Surface";
import { trpc } from "../../../services/trpc";
import { uiOverlays, uiSpacing } from "../../../uiTokens";
import {
  endLiveMeeting,
  fetchLiveMeetingStatus,
} from "../../../services/liveMeetingControl";
import {
  MEETING_STATUS,
  type MeetingStatus,
} from "../../../../types/meetingLifecycle";
import type { MeetingEventType } from "../../../../types/meetingTimeline";
import { useMeetingDetail } from "../hooks/useMeetingDetail";
import MeetingDetailHeader from "./MeetingDetailHeader";
import MeetingDetailModals from "./MeetingDetailModals";
import MeetingAudioPanel from "./MeetingAudioPanel";
import { MeetingSummaryPanel } from "./MeetingSummaryPanel";
import MeetingFullScreenLayout from "./MeetingFullScreenLayout";
import { downloadMeetingExport } from "./meetingExport";

const resolveRenameDraft = (meeting: {
  meetingName?: string;
  summaryLabel?: string;
}) => {
  if (meeting.meetingName != null && meeting.meetingName !== "") {
    return meeting.meetingName;
  }
  if (meeting.summaryLabel != null && meeting.summaryLabel !== "") {
    return meeting.summaryLabel;
  }
  return "";
};

const renderDetailStatusBadge = (status?: MeetingStatus) => {
  switch (status) {
    case MEETING_STATUS.IN_PROGRESS:
      return (
        <Badge color="red" variant="light">
          Live transcript
        </Badge>
      );
    case MEETING_STATUS.PROCESSING:
      return (
        <Badge color="yellow" variant="light">
          Processing
        </Badge>
      );
    default:
      return null;
  }
};

type MeetingDetailDrawerProps = {
  opened: boolean;
  selectedMeetingId: string | null;
  selectedGuildId: string | null;
  canManageSelectedGuild: boolean;
  channelNameMap: Map<string, string>;
  invalidateMeetingLists: () => Promise<void>;
  onClose: () => void;
};

type ViewportTestIdProps = HTMLAttributes<HTMLDivElement> & {
  "data-testid": string;
};

const timelineViewportProps: ViewportTestIdProps = {
  "data-testid": "meeting-timeline-scroll-viewport",
};

export default function MeetingDetailDrawer({
  opened,
  selectedMeetingId,
  selectedGuildId,
  canManageSelectedGuild,
  channelNameMap,
  invalidateMeetingLists,
  onClose,
}: MeetingDetailDrawerProps) {
  const theme = useMantineTheme();
  const scheme = useComputedColorScheme("dark");
  const isDark = scheme === "dark";
  const drawerOffset = theme.spacing.sm;
  const navigateAsk = useNavigate({ from: "/portal/server/$serverId/ask" });
  const navigateLibrary = useNavigate({
    from: "/portal/server/$serverId/library",
  });
  const activeRouteId = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.routeId,
  });
  const isAskRoute = activeRouteId === "/portal/server/$serverId/ask";
  const search = useSearch({ from: "/portal/server/$serverId" });
  const fullScreenFromSearch = search.fullScreen === true;
  const trpcUtils = trpc.useUtils();

  const [activeFilters, setActiveFilters] = useState<MeetingEventType[]>(
    MEETING_TIMELINE_FILTERS.map((filter) => filter.value),
  );
  const [fullScreen, setFullScreen] = useState(false);
  const [endMeetingModalOpen, setEndMeetingModalOpen] = useState(false);
  const [endMeetingLoading, setEndMeetingLoading] = useState(false);
  const [endMeetingPreflightLoading, setEndMeetingPreflightLoading] =
    useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [archiveNextState, setArchiveNextState] = useState<boolean | null>(
    null,
  );
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [summaryFeedback, setSummaryFeedback] = useState<"up" | "down" | null>(
    null,
  );
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");

  const [notesCorrectionModalOpen, setNotesCorrectionModalOpen] =
    useState(false);
  const [notesCorrectionDraft, setNotesCorrectionDraft] = useState("");
  const [notesCorrectionDiff, setNotesCorrectionDiff] = useState<string | null>(
    null,
  );
  const [notesCorrectionToken, setNotesCorrectionToken] = useState<
    string | null
  >(null);
  const [notesCorrectionChanged, setNotesCorrectionChanged] = useState<
    boolean | null
  >(null);

  const {
    detail,
    meeting,
    detailLoading,
    detailError,
    liveStreamEnabled,
    liveStream,
    displayStatus,
    displayAttendees,
    displayEvents,
    timelineEmptyLabel,
  } = useMeetingDetail({
    selectedGuildId,
    selectedMeetingId,
    channelNameMap,
    invalidateMeetingLists,
  });

  const archiveMutation = trpc.meetings.setArchived.useMutation();
  const renameMutation = trpc.meetings.rename.useMutation();
  const feedbackMutation = trpc.feedback.submitSummary.useMutation();
  const suggestNotesCorrectionMutation =
    trpc.meetings.suggestNotesCorrection.useMutation();
  const applyNotesCorrectionMutation =
    trpc.meetings.applyNotesCorrection.useMutation();

  const summaryCopyText = detail?.notes ?? "";
  const canCopySummary = summaryCopyText.trim().length > 0;

  const drawerTitle = meeting ? (
    <Group gap="xs" align="center" wrap="wrap">
      <Text fw={600} size="lg">
        {meeting.title}
      </Text>
      <ActionIcon
        variant="subtle"
        aria-label="Rename meeting"
        onClick={() => setRenameModalOpen(true)}
      >
        <IconPencil size={16} />
      </ActionIcon>
      {meeting.archivedAt ? (
        <Badge size="sm" variant="light" color="gray">
          Archived
        </Badge>
      ) : null}
      {renderDetailStatusBadge(displayStatus)}
    </Group>
  ) : (
    <Text fw={600} size="lg">
      Meeting details
    </Text>
  );

  useEffect(() => {
    if (!meeting) return;
    setRenameDraft(resolveRenameDraft(meeting));
    setRenameError(null);
    setSummaryFeedback(meeting.summaryFeedback ?? null);
    setFeedbackDraft("");
    setFeedbackModalOpen(false);

    setNotesCorrectionDraft("");
    setNotesCorrectionDiff(null);
    setNotesCorrectionToken(null);
    setNotesCorrectionChanged(null);
    setNotesCorrectionModalOpen(false);
  }, [meeting]);

  const openNotesCorrectionModal = () => {
    setNotesCorrectionModalOpen(true);
    setNotesCorrectionDraft("");
    setNotesCorrectionDiff(null);
    setNotesCorrectionToken(null);
    setNotesCorrectionChanged(null);
  };

  const closeNotesCorrectionModal = () => {
    setNotesCorrectionModalOpen(false);
    setNotesCorrectionDraft("");
    setNotesCorrectionDiff(null);
    setNotesCorrectionToken(null);
    setNotesCorrectionChanged(null);
  };

  const handleNotesCorrectionDraftChange = (value: string) => {
    setNotesCorrectionDraft(value);
    setNotesCorrectionDiff(null);
    setNotesCorrectionToken(null);
    setNotesCorrectionChanged(null);
  };

  const handleNotesCorrectionGenerate = async () => {
    if (!selectedGuildId || !selectedMeetingId) return;
    const trimmed = notesCorrectionDraft.trim();
    if (!trimmed) {
      notifications.show({
        color: "red",
        message: "Add a suggestion before generating a proposal.",
      });
      return;
    }

    try {
      const result = await suggestNotesCorrectionMutation.mutateAsync({
        serverId: selectedGuildId,
        meetingId: selectedMeetingId,
        suggestion: trimmed,
      });
      setNotesCorrectionDiff(result.diff);
      setNotesCorrectionToken(result.token);
      setNotesCorrectionChanged(result.changed);
      if (!result.changed) {
        notifications.show({
          message:
            "No changes suggested. Try adding more detail to your correction.",
        });
      }
    } catch (error) {
      console.error("Failed to suggest notes correction", error);
      notifications.show({
        color: "red",
        message: "Unable to generate a proposal right now.",
      });
    }
  };

  const handleNotesCorrectionApply = async () => {
    if (!selectedGuildId || !selectedMeetingId || !notesCorrectionToken) return;
    try {
      await applyNotesCorrectionMutation.mutateAsync({
        serverId: selectedGuildId,
        meetingId: selectedMeetingId,
        token: notesCorrectionToken,
      });
      notifications.show({ message: "Notes updated." });
      closeNotesCorrectionModal();
      void trpcUtils.meetings.detail.invalidate();
      void invalidateMeetingLists();
    } catch (error) {
      console.error("Failed applying notes correction", error);
      notifications.show({
        color: "red",
        message: "Unable to apply this correction right now.",
      });
    }
  };

  useEffect(() => {
    if (!selectedMeetingId) {
      setFullScreen(false);
      return;
    }
    setFullScreen(fullScreenFromSearch);
  }, [selectedMeetingId, fullScreenFromSearch]);

  const resetDrawerState = () => {
    setFullScreen(false);
    setEndMeetingModalOpen(false);
    setArchiveModalOpen(false);
    setArchiveNextState(null);
    setRenameModalOpen(false);
    setFeedbackModalOpen(false);
    setFeedbackDraft("");
  };

  const handleCloseDrawer = () => {
    resetDrawerState();
    onClose();
  };

  const handleToggleFullScreen = () => {
    const next = !fullScreen;
    setFullScreen(next);
    (isAskRoute ? navigateAsk : navigateLibrary)({
      search: (prev) => ({
        ...prev,
        fullScreen: next ? true : undefined,
      }),
    });
  };

  const preflightEndMeeting = async () => {
    if (!selectedGuildId || !meeting?.meetingId) return;
    try {
      setEndMeetingPreflightLoading(true);
      const status = await fetchLiveMeetingStatus(
        selectedGuildId,
        meeting.meetingId,
      );
      if (status.status !== MEETING_STATUS.IN_PROGRESS) {
        notifications.show({
          color: "gray",
          message: "Meeting is no longer live.",
        });
        return;
      }
      setEndMeetingModalOpen(true);
    } catch {
      notifications.show({
        color: "red",
        message: "Unable to refresh meeting status.",
      });
    } finally {
      setEndMeetingPreflightLoading(false);
    }
  };

  const handleConfirmEndMeeting = async () => {
    if (!selectedGuildId || !meeting?.meetingId) return;
    try {
      setEndMeetingLoading(true);
      await endLiveMeeting(selectedGuildId, meeting.meetingId);
      notifications.show({
        color: "green",
        message: "Ending meeting. Notes will arrive shortly.",
      });
      setEndMeetingModalOpen(false);
      if (liveStreamEnabled) {
        liveStream.retry();
      }
    } catch {
      notifications.show({
        color: "red",
        message: "Unable to end meeting. Please try again.",
      });
    } finally {
      setEndMeetingLoading(false);
    }
  };

  const handleArchiveToggle = async (archived: boolean): Promise<boolean> => {
    if (!selectedGuildId || !meeting) return false;
    try {
      await archiveMutation.mutateAsync({
        serverId: selectedGuildId,
        meetingId: meeting.id,
        archived,
      });
      notifications.show({
        color: "green",
        message: archived
          ? "Meeting archived. You can find it in the Archived view."
          : "Meeting unarchived.",
      });
      await Promise.all([
        invalidateMeetingLists(),
        trpcUtils.meetings.detail.invalidate(),
      ]);
      handleCloseDrawer();
      return true;
    } catch {
      notifications.show({
        color: "red",
        message: "Unable to update archive state. Please try again.",
      });
      return false;
    }
  };

  const handleArchiveConfirm = async () => {
    if (archiveNextState === null) return;
    const ok = await handleArchiveToggle(archiveNextState);
    if (!ok) return;
    setArchiveModalOpen(false);
    setArchiveNextState(null);
  };

  const handleRenameSave = async () => {
    if (!selectedGuildId || !meeting) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setRenameError("Meeting name cannot be empty.");
      return;
    }
    setRenameError(null);
    try {
      const result = await renameMutation.mutateAsync({
        serverId: selectedGuildId,
        meetingId: meeting.id,
        meetingName: trimmed,
      });
      notifications.show({
        color: "green",
        message: `Meeting renamed to ${result.meetingName}.`,
      });
      setRenameModalOpen(false);
      setRenameDraft(result.meetingName);
      await Promise.all([
        invalidateMeetingLists(),
        trpcUtils.meetings.detail.invalidate(),
      ]);
    } catch {
      setRenameError(
        renameMutation.error?.message ?? "Unable to rename meeting.",
      );
    }
  };

  const submitSummaryFeedback = async (
    rating: "up" | "down",
    comment?: string,
  ) => {
    if (!selectedGuildId || !meeting) return;
    try {
      await feedbackMutation.mutateAsync({
        serverId: selectedGuildId,
        meetingId: meeting.id,
        rating,
        comment: comment?.trim() || undefined,
      });
      setSummaryFeedback(rating);
      await trpcUtils.meetings.detail.invalidate();
      notifications.show({
        color: "green",
        message: "Thanks for the feedback.",
      });
    } catch {
      notifications.show({
        color: "red",
        message: "Unable to submit feedback right now.",
      });
    }
  };

  const handleSummaryFeedbackUp = () => {
    if (feedbackMutation.isPending) return;
    void submitSummaryFeedback("up");
  };

  const handleSummaryFeedbackDown = () => {
    if (feedbackMutation.isPending) return;
    setFeedbackModalOpen(true);
  };

  const handleSummaryFeedbackSubmit = () => {
    void submitSummaryFeedback("down", feedbackDraft);
    setFeedbackModalOpen(false);
    setFeedbackDraft("");
  };

  const handleCopySummary = async () => {
    if (!canCopySummary) return;
    try {
      await navigator.clipboard.writeText(summaryCopyText);
      notifications.show({
        color: "green",
        message: "Summary copied to clipboard.",
      });
    } catch (err) {
      notifications.show({
        color: "red",
        message: "Unable to copy the summary. Please try again.",
      });
      console.error("Failed to copy summary", err);
    }
  };

  const handleDownload = () => {
    if (!detail || !meeting) return;
    downloadMeetingExport(detail, meeting);
  };

  const audioSection = meeting ? (
    <MeetingAudioPanel audioUrl={meeting.audioUrl} />
  ) : null;

  const summarySection = meeting ? (
    <MeetingSummaryPanel
      summary={meeting.summary}
      notes={meeting.notes}
      summaryFeedback={summaryFeedback}
      feedbackPending={feedbackMutation.isPending}
      copyDisabled={!canCopySummary}
      scrollable={!fullScreen}
      onFeedbackUp={handleSummaryFeedbackUp}
      onFeedbackDown={handleSummaryFeedbackDown}
      onCopySummary={handleCopySummary}
      onSuggestCorrection={openNotesCorrectionModal}
    />
  ) : null;

  const attendeesSection = meeting ? (
    <Surface p="md">
      <Group gap="xs" mb="xs">
        <ThemeIcon variant="light" color="cyan">
          <IconUsers size={16} />
        </ThemeIcon>
        <Text fw={600}>Attendees</Text>
      </Group>
      <Text size="sm" c="dimmed">
        {displayAttendees.join(", ")}
      </Text>
    </Surface>
  ) : null;

  const fullScreenCallout = (
    <Surface p="md" tone="soft">
      <Stack gap="xs">
        <Text fw={600}>Full transcript</Text>
        <Text size="sm" c="dimmed">
          View the speaker timeline and transcript events in fullscreen.
        </Text>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconFilter size={14} />}
          onClick={() => setFullScreen(true)}
        >
          Open fullscreen
        </Button>
      </Stack>
    </Surface>
  );

  return (
    <Drawer
      opened={opened}
      onClose={handleCloseDrawer}
      position="right"
      size={fullScreen ? "100%" : "xl"}
      offset={drawerOffset}
      overlayProps={uiOverlays.modal}
      title={drawerTitle}
      data-testid="meeting-drawer"
      styles={{
        content: {
          backgroundColor: isDark ? theme.colors.dark[7] : theme.white,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        },
        header: {
          backgroundColor: isDark ? theme.colors.dark[7] : theme.white,
        },
        body: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        },
      }}
    >
      {selectedMeetingId ? (
        <Box
          data-testid="meeting-drawer-content"
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {detailError ? (
            <Center py="xl">
              <Text c="dimmed">Unable to load meeting details.</Text>
            </Center>
          ) : detailLoading ? (
            <Center py="xl">
              <Loader color="brand" />
            </Center>
          ) : meeting ? (
            <>
              <MeetingDetailModals
                notesCorrectionModalOpen={notesCorrectionModalOpen}
                notesCorrectionDraft={notesCorrectionDraft}
                notesCorrectionDiff={notesCorrectionDiff}
                notesCorrectionChanged={notesCorrectionChanged}
                onNotesCorrectionDraftChange={handleNotesCorrectionDraftChange}
                onNotesCorrectionModalClose={closeNotesCorrectionModal}
                onNotesCorrectionGenerate={handleNotesCorrectionGenerate}
                onNotesCorrectionApply={handleNotesCorrectionApply}
                notesCorrectionGenerating={
                  suggestNotesCorrectionMutation.isPending
                }
                notesCorrectionApplying={applyNotesCorrectionMutation.isPending}
                feedbackModalOpen={feedbackModalOpen}
                feedbackDraft={feedbackDraft}
                onFeedbackDraftChange={setFeedbackDraft}
                onFeedbackModalClose={() => setFeedbackModalOpen(false)}
                onFeedbackSubmit={handleSummaryFeedbackSubmit}
                feedbackSubmitting={feedbackMutation.isPending}
                endMeetingModalOpen={endMeetingModalOpen}
                onEndMeetingModalClose={() => setEndMeetingModalOpen(false)}
                onConfirmEndMeeting={handleConfirmEndMeeting}
                endMeetingLoading={endMeetingLoading}
                archiveModalOpen={archiveModalOpen}
                archiveNextState={archiveNextState}
                onArchiveModalClose={() => {
                  setArchiveModalOpen(false);
                  setArchiveNextState(null);
                }}
                onArchiveConfirm={handleArchiveConfirm}
                archivePending={archiveMutation.isPending}
                renameModalOpen={renameModalOpen}
                renameDraft={renameDraft}
                renameError={renameError}
                onRenameDraftChange={setRenameDraft}
                onRenameModalClose={() => setRenameModalOpen(false)}
                onRenameSave={handleRenameSave}
                renamePending={renameMutation.isPending}
              />
              <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
                <MeetingDetailHeader
                  meeting={meeting}
                  displayStatus={displayStatus}
                  canManageSelectedGuild={canManageSelectedGuild}
                  endMeetingPreflightLoading={endMeetingPreflightLoading}
                  archivePending={archiveMutation.isPending}
                  fullScreen={fullScreen}
                  onEndMeeting={preflightEndMeeting}
                  onDownload={handleDownload}
                  onArchiveToggle={() => {
                    setArchiveNextState(!meeting.archivedAt);
                    setArchiveModalOpen(true);
                  }}
                  onToggleFullScreen={handleToggleFullScreen}
                />

                {fullScreen ? (
                  <MeetingFullScreenLayout
                    left={
                      <ScrollArea
                        style={{ flex: 1, minHeight: 0 }}
                        offsetScrollbars
                        type="always"
                        scrollbarSize={10}
                        data-visual-scroll
                        data-testid="meeting-detail-left-scroll"
                        styles={{
                          viewport: {
                            paddingRight: `var(--mantine-spacing-${uiSpacing.scrollAreaGutter})`,
                          },
                        }}
                      >
                        <Stack gap="md">
                          {audioSection}
                          {summarySection}
                          {attendeesSection}
                        </Stack>
                      </ScrollArea>
                    }
                    right={
                      <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
                        {liveStreamEnabled && liveStream.status === "error" ? (
                          <Text size="sm" c="dimmed">
                            Unable to connect to the live transcript. Try
                            refreshing.
                          </Text>
                        ) : null}
                        <Surface
                          p="md"
                          style={{
                            flex: 1,
                            minHeight: 0,
                            display: "flex",
                            flexDirection: "column",
                            overflow: "hidden",
                          }}
                        >
                          <MeetingTimeline
                            events={displayEvents}
                            activeFilters={activeFilters}
                            onToggleFilter={(value) =>
                              setActiveFilters((current) =>
                                current.includes(value)
                                  ? current.filter((filter) => filter !== value)
                                  : [...current, value],
                              )
                            }
                            height="100%"
                            title="Transcript"
                            emptyLabel={timelineEmptyLabel}
                            viewportProps={timelineViewportProps}
                          />
                        </Surface>
                      </Stack>
                    }
                  />
                ) : (
                  <Stack
                    gap="md"
                    style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
                  >
                    {audioSection}
                    {summarySection}
                    {attendeesSection}
                    {fullScreenCallout}
                  </Stack>
                )}
              </Stack>
            </>
          ) : null}
        </Box>
      ) : null}
    </Drawer>
  );
}
