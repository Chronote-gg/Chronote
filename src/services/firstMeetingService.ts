import { TRPCError } from "@trpc/server";
import { getActiveMeetingLease } from "../db";
import { CONFIG_KEYS } from "../config/keys";
import type { ActiveMeetingLease, MeetingHistory } from "../types/db";
import type {
  FirstMeetingState,
  FirstMeetingTarget,
} from "../types/firstMeeting";
import { buildPortalMeetingUrl } from "../utils/portalLinks";
import {
  formatMeetingCaptureNotice,
  formatRecoveryNotice,
} from "../utils/meetingCaptureNotice";
import { config } from "./configService";
import { ensureUserCanReadChannelHistory } from "./discordPermissionsService";
import { ensureUserCanAccessMeeting } from "./meetingAccessService";
import {
  getMeetingHistoryService,
  listRecentMeetingsForGuildService,
} from "./meetingHistoryService";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "./unifiedConfigService";

const RECENT_MEETING_LIMIT = 50;

function permissionUnavailable(): never {
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: "Discord rate limited. Please retry.",
  });
}

async function authorizedDiscordUrl(
  history: MeetingHistory,
  userId: string,
): Promise<string | null> {
  const channelId = history.notesChannelId || history.textChannelId;
  let discordUrl: string | null = null;
  if (channelId) {
    const allowed = await ensureUserCanReadChannelHistory({
      guildId: history.guildId,
      channelId,
      userId,
    });
    if (allowed === null) permissionUnavailable();
    if (allowed) {
      const messageId =
        history.notesMessageIds?.[0]?.trim() ||
        (channelId === history.textChannelId
          ? history.summaryMessageId?.trim()
          : undefined);
      discordUrl = `https://discord.com/channels/${history.guildId}/${channelId}${messageId ? `/${messageId}` : ""}`;
    }
  }
  return discordUrl;
}

async function buildTarget(
  history: MeetingHistory,
  userId: string,
): Promise<FirstMeetingTarget> {
  return {
    historyId: history.channelId_timestamp,
    title:
      history.meetingName?.trim() || history.summaryLabel?.trim() || "Meeting",
    portalUrl: buildPortalMeetingUrl({
      baseUrl: config.frontend.siteUrl,
      guildId: history.guildId,
      meetingId: history.channelId_timestamp,
    }),
    discordUrl: await authorizedDiscordUrl(history, userId),
    captureNotice: formatMeetingCaptureNotice(history) ?? null,
    recoveryNotice: formatRecoveryNotice(history.recovery) ?? null,
  };
}

function hasCompleteNotesDelivery(history: MeetingHistory): boolean {
  const delivery = history.delivery?.notes;
  if (delivery?.outcome !== "complete") return false;
  const pointers = (history.notesMessageIds ?? []).map((id) => id.trim());
  return (
    Number.isInteger(delivery.intended) &&
    delivery.intended > 0 &&
    delivery.sent === delivery.intended &&
    delivery.errors.length === 0 &&
    Boolean(history.notesChannelId?.trim() || history.textChannelId?.trim()) &&
    pointers.length === delivery.intended &&
    pointers.every(Boolean) &&
    new Set(pointers).size === pointers.length
  );
}

function matchesActiveLease(
  lease: ActiveMeetingLease,
  history: MeetingHistory,
): boolean {
  return (
    lease.sessionMode !== "tts_only" &&
    lease.guildId === history.guildId &&
    lease.meetingId === history.meetingId &&
    Boolean(history.ownerInstanceId) &&
    lease.ownerInstanceId === history.ownerInstanceId &&
    history.executionVersion !== undefined &&
    lease.executionVersion === history.executionVersion &&
    lease.leaseExpiresAt >= Math.floor(Date.now() / 1000)
  );
}

async function verifiedLiveKind(
  history: MeetingHistory,
): Promise<"recording" | "processing" | null> {
  const lease = await getActiveMeetingLease(history.guildId);
  if (!lease || !matchesActiveLease(lease, history)) return null;
  if (history.status === "interrupted" && lease.sessionMode !== "recovery")
    return null;
  if (lease.status === "processing") return "processing";
  if (
    lease.sessionMode !== "recovery" &&
    (lease.status === "starting" || lease.status === "in_progress")
  ) {
    return "recording";
  }
  return null;
}

async function deriveState(
  history: MeetingHistory,
  meeting: FirstMeetingTarget,
): Promise<FirstMeetingState> {
  if (history.notes?.trim()) {
    const delivery = history.delivery?.notes;
    if (delivery?.outcome === "partial" || delivery?.outcome === "failed") {
      return {
        kind: "delivery_attention",
        delivery: delivery.outcome,
        meeting,
      };
    }
    return {
      kind: hasCompleteNotesDelivery(history) ? "ready" : "saved",
      meeting,
    };
  }
  const active =
    history.status === "starting" ||
    history.status === "in_progress" ||
    history.status === "processing";
  if (active || history.status === "interrupted") {
    const kind = await verifiedLiveKind(history);
    if (kind) return { kind, meeting };
  }
  if (active) return { kind: "attention", reason: "status_unknown", meeting };
  return terminalState(history, meeting);
}

function terminalState(
  history: MeetingHistory,
  meeting: FirstMeetingTarget,
): FirstMeetingState {
  if (
    history.capture?.kind === "interrupted" ||
    history.status === "interrupted"
  ) {
    return { kind: "attention", reason: "interrupted", meeting };
  }
  const failed =
    history.status === "failed" ||
    history.processing?.notes === "failed" ||
    history.processing?.transcription === "failed";
  return {
    kind: "attention",
    reason: failed ? "processing_failed" : "no_notes",
    meeting,
  };
}

export async function getFirstMeetingState(input: {
  guildId: string;
  userId: string;
  historyId?: string;
}): Promise<FirstMeetingState> {
  const snapshot = await resolveConfigSnapshot({ guildId: input.guildId });
  const attendeeOverrideEnabled = getSnapshotBoolean(
    snapshot,
    CONFIG_KEYS.meetings.attendeeAccessEnabled,
  );
  const rows = input.historyId
    ? [await getMeetingHistoryService(input.guildId, input.historyId)]
    : await listRecentMeetingsForGuildService(
        input.guildId,
        RECENT_MEETING_LIMIT,
        { includeArchived: false },
      );
  const candidates = rows
    .filter((row): row is MeetingHistory => Boolean(row))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const history of candidates) {
    const allowed = await ensureUserCanAccessMeeting({
      guildId: input.guildId,
      userId: input.userId,
      meeting: history,
      attendeeOverrideEnabled,
    });
    if (allowed === null) permissionUnavailable();
    if (!allowed) continue;
    return deriveState(history, await buildTarget(history, input.userId));
  }
  if (input.historyId)
    throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
  return { kind: "guide" };
}
