import type { MeetingHistory } from "../types/db";
import {
  isPersonalMeeting,
  resolvePersonalMeetingAccess,
} from "../utils/meetingOwnership";
import {
  ensureUserCanConnectChannel,
  ensureUserCanReadChannelHistory,
} from "./discordPermissionsService";

export type MeetingAccessMissingPermission =
  | "voice_connect"
  | "notes_read_history";

export type MeetingAccessDecision =
  | {
      allowed: true;
      via:
        | "attendee"
        | "channel_permissions"
        | "owner"
        | "user_share"
        | "guild_share";
    }
  | { allowed: false; missing: MeetingAccessMissingPermission[] }
  | { allowed: null; missing: MeetingAccessMissingPermission[] };

type MeetingAccessRecord = Pick<
  MeetingHistory,
  | "accessGrants"
  | "channelId"
  | "channelId_timestamp"
  | "guildId"
  | "meetingCreatorId"
  | "notesChannelId"
  | "ownerUserId"
  | "ownershipScope"
  | "participants"
  | "textChannelId"
>;

const resolveVoiceChannelId = (meeting: {
  channelId?: string | null;
  channelId_timestamp?: string | null;
}): string | null => {
  const direct = meeting.channelId?.trim();
  if (direct) return direct;
  const key = meeting.channelId_timestamp?.trim();
  if (!key) return null;
  const [channelId] = key.split("#");
  return channelId?.trim() ? channelId.trim() : null;
};

const resolveSummaryTextChannelId = (meeting: {
  textChannelId?: string | null;
  notesChannelId?: string | null;
}): string | null => {
  const direct = meeting.textChannelId?.trim();
  if (direct) return direct;
  const fallback = meeting.notesChannelId?.trim();
  if (fallback) return fallback;
  return null;
};

const isMeetingParticipant = (meeting: {
  participants?: Array<{ id: string }> | null;
}): ((userId: string) => boolean) => {
  const ids = new Set(
    (meeting.participants ?? [])
      .map((participant) => participant?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  return (userId: string) => ids.has(userId);
};

export async function ensureUserCanAccessMeeting(options: {
  guildId: string;
  meeting: MeetingAccessRecord;
  userId: string;
  attendeeOverrideEnabled?: boolean;
  sharedGuildIds?: string[];
}): Promise<boolean | null> {
  const decision = await checkUserMeetingAccess(options);
  return decision.allowed;
}

export async function checkUserMeetingAccess(options: {
  guildId: string;
  meeting: MeetingAccessRecord;
  userId: string;
  attendeeOverrideEnabled?: boolean;
  sharedGuildIds?: string[];
}): Promise<MeetingAccessDecision> {
  const { guildId, userId, meeting } = options;
  const attendeeOverrideEnabled = options.attendeeOverrideEnabled !== false;

  const personalAccess = resolvePersonalMeetingAccess(
    meeting,
    userId,
    options.sharedGuildIds,
  );
  if (personalAccess) {
    return { allowed: true, via: personalAccess };
  }
  if (isPersonalMeeting(meeting)) {
    return { allowed: false, missing: [] };
  }

  if (attendeeOverrideEnabled && isMeetingParticipant(meeting)(userId)) {
    return { allowed: true, via: "attendee" };
  }

  const voiceChannelId = resolveVoiceChannelId(meeting);
  if (!voiceChannelId) {
    return { allowed: false, missing: ["voice_connect"] };
  }

  const canConnect = await ensureUserCanConnectChannel({
    guildId,
    channelId: voiceChannelId,
    userId,
  });
  if (canConnect === null) {
    return { allowed: null, missing: ["voice_connect"] };
  }
  if (!canConnect) {
    return { allowed: false, missing: ["voice_connect"] };
  }

  const textChannelId = resolveSummaryTextChannelId(meeting);
  if (!textChannelId) {
    // Backwards-compatibility for older records that did not store the
    // summary/notes channel id. In that case we can only enforce voice access.
    return { allowed: true, via: "channel_permissions" };
  }

  const canReadHistory = await ensureUserCanReadChannelHistory({
    guildId,
    channelId: textChannelId,
    userId,
  });
  if (canReadHistory === null) {
    return { allowed: null, missing: ["notes_read_history"] };
  }
  if (!canReadHistory) {
    return { allowed: false, missing: ["notes_read_history"] };
  }

  return { allowed: true, via: "channel_permissions" };
}
