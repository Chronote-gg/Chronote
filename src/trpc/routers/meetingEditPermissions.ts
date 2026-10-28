import { TRPCError } from "@trpc/server";
import { CONFIG_KEYS } from "../../config/keys";
import { ensureUserCanManageChannel } from "../../services/discordPermissionsService";
import type { GuildSessionCache } from "../../services/guildAccessService";
import {
  checkUserMeetingAccess,
  resolvePersonalMeetingSharedGuildIds,
  type MeetingAccessMissingPermission,
} from "../../services/meetingAccessService";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "../../services/unifiedConfigService";
import type { MeetingHistory } from "../../types/db";
import {
  isPersonalMeeting,
  resolveMeetingOwnerUserId,
} from "../../utils/meetingOwnership";

export const parseChannelIdTimestamp = (channelIdTimestamp: string) => {
  const hashIndex = channelIdTimestamp.indexOf("#");
  if (hashIndex <= 0 || hashIndex >= channelIdTimestamp.length - 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid meeting id.",
    });
  }

  return {
    channelId: channelIdTimestamp.slice(0, hashIndex),
    timestamp: channelIdTimestamp.slice(hashIndex + 1),
  };
};

export const resolveAttendeeAccessEnabled = async (guildId: string) => {
  try {
    const snapshot = await resolveConfigSnapshot({ guildId });
    return getSnapshotBoolean(
      snapshot,
      CONFIG_KEYS.meetings.attendeeAccessEnabled,
    );
  } catch (error) {
    console.warn("Failed to resolve attendee access setting", {
      guildId,
      error,
    });
    return true;
  }
};

const formatMeetingAccessErrorMessage = (options: {
  missing: MeetingAccessMissingPermission[];
  attendeeOverrideEnabled: boolean;
}) => {
  const reasons: string[] = [];
  if (options.missing.includes("voice_connect")) {
    reasons.push(
      "You need permission to join the meeting voice channel (View Channel + Connect).",
    );
  }
  if (options.missing.includes("notes_read_history")) {
    reasons.push(
      "You need permission to read message history in the notes channel (View Channel + Read Message History).",
    );
  }

  const detail = reasons.length ? ` ${reasons.join(" ")}` : "";
  const attendeeHint = options.attendeeOverrideEnabled
    ? ""
    : " If you attended this meeting, a server admin can enable Attendee access in Settings.";
  return `Meeting access required.${detail}${attendeeHint}`.trim();
};

export const ensurePortalUserCanAccessMeeting = async (options: {
  accessToken?: string;
  guildId: string;
  meeting: MeetingHistory;
  session?: GuildSessionCache;
  userId: string;
  attendeeOverrideEnabled: boolean;
}) => {
  const sharedGuildIds = await resolvePersonalMeetingSharedGuildIds({
    accessToken: options.accessToken,
    meeting: options.meeting,
    session: options.session,
    userId: options.userId,
  });
  if (sharedGuildIds === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  const decision = await checkUserMeetingAccess({
    guildId: options.guildId,
    meeting: options.meeting,
    userId: options.userId,
    attendeeOverrideEnabled: options.attendeeOverrideEnabled,
    sharedGuildIds,
  });
  if (decision.allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!decision.allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: formatMeetingAccessErrorMessage({
        missing: decision.missing,
        attendeeOverrideEnabled: options.attendeeOverrideEnabled,
      }),
    });
  }
};

export const ensurePortalUserCanManageMeetingChannel = async (options: {
  guildId: string;
  channelId: string;
  userId: string;
}) => {
  const allowed = await ensureUserCanManageChannel(options);
  if (allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Manage channel permission required",
    });
  }
};

export const ensurePortalUserCanEditMeetingNotes = async (params: {
  accessToken?: string;
  guildId: string;
  meeting: MeetingHistory;
  channelId: string;
  session?: GuildSessionCache;
  userId: string;
  forbiddenMessage: string;
}) => {
  const attendeeOverrideEnabled = isPersonalMeeting(params.meeting)
    ? true
    : await resolveAttendeeAccessEnabled(params.guildId);
  await ensurePortalUserCanAccessMeeting({
    accessToken: params.accessToken,
    guildId: params.guildId,
    meeting: params.meeting,
    session: params.session,
    userId: params.userId,
    attendeeOverrideEnabled,
  });

  const isMeetingOwner =
    resolveMeetingOwnerUserId(params.meeting) === params.userId;
  if (isMeetingOwner) {
    return;
  }

  if (params.meeting.isAutoRecording) {
    await ensurePortalUserCanManageMeetingChannel({
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
    });
    return;
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: params.forbiddenMessage,
  });
};
