import { randomUUID } from "node:crypto";
import { runRuntimeApiOperation } from "./runtimeApiOperationService";
import {
  runNotionMutation,
  assertNotionOutcomeKnown,
} from "./notionOperationLifetime";
import { getNotionIntegrationRepository } from "../repositories/notionIntegrationRepository";
import type { MeetingHistory } from "../types/db";
import { MEETING_STATUS } from "../types/meetingLifecycle";
import type {
  NotionAutomationConfig,
  NotionAutomationMeetingExport,
} from "../types/notionIntegration";
import {
  buildPersonalMeetingGuildId,
  isPersonalMeeting,
  resolveMeetingOwnerUserId,
} from "../utils/meetingOwnership";
import { config as appConfig } from "./configService";
import {
  exportMeetingToNotionAutomation,
  NotionApiError,
  syncMeetingToNotionAutomation,
} from "./notionService";

type AutomationMeetingExportKey = {
  guildId: string;
  meetingId: string;
};

type RunAutoExportParams = {
  meeting: MeetingHistory;
  force?: boolean;
  recovery?: true;
  signal?: AbortSignal;
};

const hasNotes = (meeting: MeetingHistory) =>
  Boolean(meeting.notes && meeting.notes.trim().length > 0);

const hasUnfinishedRecovery = (meeting: MeetingHistory) =>
  Boolean(meeting.recovery && meeting.recovery.disposition !== "done") ||
  Boolean(
    meeting.recoveryExport &&
    !["acknowledged", "skipped"].includes(meeting.recoveryExport.state),
  );

const isCompletedMeeting = (meeting: MeetingHistory, recovery = false) =>
  (recovery || !hasUnfinishedRecovery(meeting)) &&
  ((meeting.status ?? MEETING_STATUS.COMPLETE) === MEETING_STATUS.COMPLETE ||
    (meeting.status === MEETING_STATUS.INTERRUPTED &&
      ((meeting.recovery?.disposition === "done" &&
        meeting.recovery.outcome === "completed") ||
        (recovery &&
          meeting.recovery?.stage === "export" &&
          meeting.recoveryExport?.state === "pending"))));

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

const matchesPersonalAutomationOwner = (
  config: NotionAutomationConfig,
  meeting: MeetingHistory,
) => {
  if (!isPersonalMeeting(meeting)) return true;
  const ownerUserId = resolveMeetingOwnerUserId(meeting);
  return (
    ownerUserId === config.ownerUserId &&
    meeting.guildId === buildPersonalMeetingGuildId(config.ownerUserId)
  );
};

const isEligible = (
  config: NotionAutomationConfig,
  meeting: MeetingHistory,
  recovery = false,
) =>
  config.autoExportEnabled &&
  isCompletedMeeting(meeting, recovery) &&
  hasNotes(meeting) &&
  matchesPersonalAutomationOwner(config, meeting) &&
  matchesChannelFilter(config, meeting) &&
  matchesTagFilter(config, meeting);

const getErrorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Notion automation failed.";

const clearConfigError = async (
  config: NotionAutomationConfig,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  if (!config.lastError) return;
  await runNotionMutation(signal, () =>
    getNotionIntegrationRepository().writeAutomationConfig(
      {
        ...config,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      },
      signal,
    ),
  );
  signal?.throwIfAborted();
};

const recordConfigError = async (
  config: NotionAutomationConfig,
  error: unknown,
  signal?: AbortSignal,
) => {
  await runNotionMutation(signal, () =>
    getNotionIntegrationRepository().writeAutomationConfig(
      {
        ...config,
        lastError: getErrorMessage(error),
        updatedAt: new Date().toISOString(),
      },
      signal,
    ),
  );
  signal?.throwIfAborted();
};

const buildFailedExport = (params: {
  config: NotionAutomationConfig;
  meeting: MeetingHistory;
  existing?: NotionAutomationMeetingExport;
  signal?: AbortSignal;
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
  signal?: AbortSignal;
  error: unknown;
}) => {
  await runNotionMutation(params.signal, () =>
    getNotionIntegrationRepository().writeAutomationMeetingExport(
      buildFailedExport(params),
      params.signal,
    ),
  );
  params.signal?.throwIfAborted();
  await recordConfigError(params.config, params.error, params.signal);
};

const getAutomationConfig = (guildId: string, signal?: AbortSignal) =>
  getNotionIntegrationRepository().getAutomationConfig(guildId, signal);

const throwNotionNotConfigured = () => {
  throw new NotionApiError(
    400,
    "notion_not_configured",
    "Notion export is not configured.",
  );
};

const throwAutomationNotConfigured = () => {
  throw new NotionApiError(
    404,
    "automation_not_configured",
    "Notion automation is not configured for this server.",
  );
};

const throwAutomationNotEligible = () => {
  throw new NotionApiError(
    400,
    "automation_not_eligible",
    "Notion automation is not enabled for this meeting.",
  );
};

const getRunnableAutomationConfig = async ({
  meeting,
  force,
  signal,
  recovery,
}: RunAutoExportParams) => {
  if (!appConfig.notion.enabled) {
    if (force) throwNotionNotConfigured();
    return undefined;
  }

  signal?.throwIfAborted();
  const config = await getAutomationConfig(meeting.guildId, signal);
  signal?.throwIfAborted();
  if (!config) {
    if (force) throwAutomationNotConfigured();
    return undefined;
  }

  if (!isEligible(config, meeting, recovery)) {
    if (force) throwAutomationNotEligible();
    return undefined;
  }

  return config;
};

const reserveNewAutomationExport = async (params: {
  existing?: NotionAutomationMeetingExport;
  signal?: AbortSignal;
  key: AutomationMeetingExportKey;
}) => {
  if (params.existing) return true;
  return getNotionIntegrationRepository().reserveAutomationMeetingExport(
    params.key,
    params.signal,
  );
};

const writeNotionAutomationExport = (params: {
  config: NotionAutomationConfig;
  meeting: MeetingHistory;
  existing?: NotionAutomationMeetingExport;
  signal?: AbortSignal;
}) => {
  if (params.existing?.notionPageId) {
    return syncMeetingToNotionAutomation({
      userId: params.config.ownerUserId,
      meeting: params.meeting,
      existing: params.existing,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  return exportMeetingToNotionAutomation({
    userId: params.config.ownerUserId,
    meeting: params.meeting,
    destinationPageId: params.config.destinationPageId,
    attemptCount: (params.existing?.attemptCount ?? 0) + 1,
    ...(params.signal ? { signal: params.signal } : {}),
  });
};

const runAutoExport = async (params: RunAutoExportParams) => {
  const config = await getRunnableAutomationConfig(params);
  if (!config) return undefined;

  const repository = getNotionIntegrationRepository();
  const key = {
    guildId: params.meeting.guildId,
    meetingId: params.meeting.channelId_timestamp,
  };
  params.signal?.throwIfAborted();
  const existing = await repository.getAutomationMeetingExport(
    key,
    params.signal,
  );
  params.signal?.throwIfAborted();
  if (existing?.status === "exported" && !params.force) return existing;
  if (existing && !params.force) {
    if (params.recovery)
      throw new Error("Existing Notion export requires reconciliation");
    return existing;
  }

  const reserved = await runNotionMutation(params.signal, () =>
    reserveNewAutomationExport({ existing, key, signal: params.signal }),
  );
  params.signal?.throwIfAborted();
  if (!reserved) {
    if (params.recovery)
      throw new Error("Notion reservation outcome requires reconciliation");
    return undefined;
  }

  try {
    const exported = await writeNotionAutomationExport({
      config,
      meeting: params.meeting,
      existing,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    await clearConfigError(config, params.signal);
    return exported;
  } catch (error) {
    assertNotionOutcomeKnown(error, params.signal);
    if (params.recovery) throw error;
    await writeFailure({
      config,
      meeting: params.meeting,
      existing,
      error,
      signal: params.signal,
    });
    if (params.force) throw error;
    return undefined;
  }
};

export const maybeAutoExportCompletedMeeting = async (
  meeting: MeetingHistory,
  signal?: AbortSignal,
) => {
  try {
    await runAutoExport({ meeting, signal });
  } catch (error) {
    assertNotionOutcomeKnown(error, signal);
    console.warn("Notion auto-export failed", {
      guildId: meeting.guildId,
      meetingId: meeting.meetingId,
      error,
    });
  }
};

/** Recovery must distinguish disabled rules from a swallowed read/export failure. */
export const autoExportRecoveredMeeting = async (
  meeting: MeetingHistory,
  signal?: AbortSignal,
): Promise<"acknowledged" | "skipped"> => {
  if (
    meeting.recovery?.stage !== "export" ||
    meeting.recoveryExport?.state !== "pending"
  )
    throw new Error("Recovery export is not pending");
  const exported = await runAutoExport({ meeting, signal, recovery: true });
  if (!exported) return "skipped";
  if (exported.status !== "exported" || !exported.notionPageId)
    throw new Error("Notion export acknowledgment missing");
  return "acknowledged";
};

export const retryNotionAutomationExport = async (meeting: MeetingHistory) => {
  const exported = await runRuntimeApiOperation(
    `notion-retry:${randomUUID()}`,
    (operation) =>
      runAutoExport({ meeting, force: true, signal: operation.signal }),
  );
  if (!exported) {
    throw new NotionApiError(
      409,
      "automation_retry_conflict",
      "Notion automation retry is already in progress. Try again shortly.",
    );
  }
  return exported;
};

export const maybeAutoSyncMeetingNotes = async (
  meeting: MeetingHistory,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  if (!appConfig.notion.enabled || hasUnfinishedRecovery(meeting)) return;

  signal?.throwIfAborted();
  const config = await getAutomationConfig(meeting.guildId, signal);
  signal?.throwIfAborted();
  if (!config || !config.autoExportEnabled || !hasNotes(meeting)) return;
  if (!matchesPersonalAutomationOwner(config, meeting)) return;
  const repository = getNotionIntegrationRepository();
  const existing = await repository.getAutomationMeetingExport(
    {
      guildId: meeting.guildId,
      meetingId: meeting.channelId_timestamp,
    },
    signal,
  );
  signal?.throwIfAborted();
  if (!existing || existing.status !== "exported") return;
  if (existing.exportedNotesVersion >= (meeting.notesVersion ?? 1)) return;

  try {
    await syncMeetingToNotionAutomation({
      userId: config.ownerUserId,
      meeting,
      existing,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    await clearConfigError(config, signal);
  } catch (error) {
    assertNotionOutcomeKnown(error, signal);
    await writeFailure({ config, meeting, existing, error, signal });
  }
};
