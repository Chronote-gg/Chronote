import { getNotionIntegrationRepository } from "../repositories/notionIntegrationRepository";
import type { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import type {
  NotionAutomationConfig,
  NotionAutomationMeetingExport,
} from "../types/notionIntegration";
import {
  exportMeetingToNotionAutomation,
  NotionApiError,
  syncMeetingToNotionAutomation,
} from "./notionService";

const hasNotes = (meeting: MeetingHistory) =>
  Boolean(meeting.notes && meeting.notes.trim().length > 0);

const isCompletedMeeting = (meeting: MeetingHistory) =>
  (meeting.status ?? MEETING_STATUS.COMPLETE) === MEETING_STATUS.COMPLETE;

const matchesChannelFilter = (
  config: NotionAutomationConfig,
  meeting: MeetingHistory,
) => {
  const channelIds = config.channelIds ?? [];
  return channelIds.length === 0 || channelIds.includes(meeting.channelId);
};

const matchesTagFilter = (
  config: NotionAutomationConfig,
  meeting: MeetingHistory,
) => {
  const tags = config.tags ?? [];
  if (tags.length === 0) return true;
  const meetingTags = new Set(meeting.tags ?? []);
  return tags.some((tag) => meetingTags.has(tag));
};

const isEligible = (config: NotionAutomationConfig, meeting: MeetingHistory) =>
  config.autoExportEnabled &&
  isCompletedMeeting(meeting) &&
  hasNotes(meeting) &&
  matchesChannelFilter(config, meeting) &&
  matchesTagFilter(config, meeting);

const getErrorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Notion automation failed.";

const clearConfigError = async (config: NotionAutomationConfig) => {
  if (!config.lastError) return;
  await getNotionIntegrationRepository().writeAutomationConfig({
    ...config,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  });
};

const recordConfigError = async (
  config: NotionAutomationConfig,
  error: unknown,
) => {
  await getNotionIntegrationRepository().writeAutomationConfig({
    ...config,
    lastError: getErrorMessage(error),
    updatedAt: new Date().toISOString(),
  });
};

const buildFailedExport = (params: {
  config: NotionAutomationConfig;
  meeting: MeetingHistory;
  existing?: NotionAutomationMeetingExport;
  error: unknown;
}): NotionAutomationMeetingExport => ({
  guildId: params.meeting.guildId,
  channelId_timestamp: params.meeting.channelId_timestamp,
  ownerUserId: params.config.ownerUserId,
  notionPageId: params.existing?.notionPageId,
  notionPageUrl: params.existing?.notionPageUrl,
  notionWorkspaceId: params.existing?.notionWorkspaceId,
  exportedNotesVersion:
    params.existing?.exportedNotesVersion ?? params.meeting.notesVersion ?? 1,
  status: "failed",
  attemptCount: (params.existing?.attemptCount ?? 0) + 1,
  lastAttemptAt: new Date().toISOString(),
  lastExportedAt: params.existing?.lastExportedAt,
  lastError: getErrorMessage(params.error),
});

const writeFailure = async (params: {
  config: NotionAutomationConfig;
  meeting: MeetingHistory;
  existing?: NotionAutomationMeetingExport;
  error: unknown;
}) => {
  await getNotionIntegrationRepository().writeAutomationMeetingExport(
    buildFailedExport(params),
  );
  await recordConfigError(params.config, params.error);
};

const getAutomationConfig = (guildId: string) =>
  getNotionIntegrationRepository().getAutomationConfig(guildId);

const runAutoExport = async (params: {
  meeting: MeetingHistory;
  force?: boolean;
}) => {
  const config = await getAutomationConfig(params.meeting.guildId);
  if (!config) {
    if (params.force) {
      throw new NotionApiError(
        404,
        "automation_not_configured",
        "Notion automation is not configured for this server.",
      );
    }
    return undefined;
  }
  if (!isEligible(config, params.meeting)) {
    if (params.force) {
      throw new NotionApiError(
        400,
        "automation_not_eligible",
        "Notion automation is not enabled for this meeting.",
      );
    }
    return undefined;
  }

  const repository = getNotionIntegrationRepository();
  const key = {
    guildId: params.meeting.guildId,
    meetingId: params.meeting.channelId_timestamp,
  };
  const existing = await repository.getAutomationMeetingExport(key);
  if (existing?.status === "exported" && !params.force) return existing;
  if (existing && !params.force) return existing;

  if (!existing) {
    const reserved = await repository.reserveAutomationMeetingExport(key);
    if (!reserved) return undefined;
  }

  try {
    const exported = await exportMeetingToNotionAutomation({
      userId: config.ownerUserId,
      meeting: params.meeting,
      destinationPageId: config.destinationPageId,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
    });
    await clearConfigError(config);
    return exported;
  } catch (error) {
    await writeFailure({ config, meeting: params.meeting, existing, error });
    if (params.force) throw error;
    return undefined;
  }
};

export const maybeAutoExportCompletedMeeting = async (
  meeting: MeetingHistory,
) => {
  try {
    await runAutoExport({ meeting });
  } catch (error) {
    console.warn("Notion auto-export failed", {
      guildId: meeting.guildId,
      meetingId: meeting.meetingId,
      error,
    });
  }
};

export const retryNotionAutomationExport = (meeting: MeetingHistory) =>
  runAutoExport({ meeting, force: true });

export const maybeAutoSyncMeetingNotes = async (meeting: MeetingHistory) => {
  const config = await getAutomationConfig(meeting.guildId);
  if (!config || !config.autoExportEnabled || !hasNotes(meeting)) return;
  const repository = getNotionIntegrationRepository();
  const existing = await repository.getAutomationMeetingExport({
    guildId: meeting.guildId,
    meetingId: meeting.channelId_timestamp,
  });
  if (!existing || existing.status !== "exported") return;
  if (existing.exportedNotesVersion >= (meeting.notesVersion ?? 1)) return;

  try {
    await syncMeetingToNotionAutomation({
      userId: config.ownerUserId,
      meeting,
      existing,
    });
    await clearConfigError(config);
  } catch (error) {
    await writeFailure({ config, meeting, existing, error });
  }
};
