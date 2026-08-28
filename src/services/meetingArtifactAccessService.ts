import { CONFIG_KEYS } from "../config/keys";
import type { MeetingHistory } from "../types/db";
import { isPersonalMeeting } from "../utils/meetingOwnership";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "./unifiedConfigService";

export type MeetingArtifactAccess = {
  transcriptAccessEnabled: boolean;
  audioAccessEnabled: boolean;
};

const PERSONAL_MEETING_ARTIFACT_ACCESS: MeetingArtifactAccess = {
  transcriptAccessEnabled: true,
  audioAccessEnabled: true,
};

const UNAVAILABLE_MEETING_ARTIFACT_ACCESS: MeetingArtifactAccess = {
  transcriptAccessEnabled: false,
  audioAccessEnabled: false,
};

export async function resolveServerMeetingArtifactAccess(
  guildId: string,
): Promise<MeetingArtifactAccess> {
  try {
    const snapshot = await resolveConfigSnapshot({ guildId });
    return {
      transcriptAccessEnabled: getSnapshotBoolean(
        snapshot,
        CONFIG_KEYS.meetings.transcriptAccessEnabled,
      ),
      audioAccessEnabled: getSnapshotBoolean(
        snapshot,
        CONFIG_KEYS.meetings.audioAccessEnabled,
      ),
    };
  } catch (error) {
    console.error("Failed to resolve meeting artifact access", {
      guildId,
      error,
    });
    return UNAVAILABLE_MEETING_ARTIFACT_ACCESS;
  }
}

export async function resolveServerAttendeeAccessEnabled(
  guildId: string,
): Promise<boolean> {
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
    return false;
  }
}

export async function resolveMeetingArtifactAccess(
  meeting: Pick<
    MeetingHistory,
    "accessGrants" | "guildId" | "ownerUserId" | "ownershipScope"
  >,
): Promise<MeetingArtifactAccess> {
  if (isPersonalMeeting(meeting)) {
    return PERSONAL_MEETING_ARTIFACT_ACCESS;
  }
  return resolveServerMeetingArtifactAccess(meeting.guildId);
}
