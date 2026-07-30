import type { MeetingHistory } from "../types/db";
import { isPersonalMeeting } from "../utils/meetingOwnership";
import { listGuildRolesCached } from "./discordCacheService";
import {
  formatParticipantRoster,
  formatRoleRoster,
  isMentionableRole,
  selectRolesForPrompt,
  NO_ROLES_AVAILABLE_TEXT,
} from "./notesPromptService";

export const NO_PARTICIPANT_ROSTER_TEXT = "No participant roster captured.";

export type MentionRosters = {
  /** Rendered exactly as the notes prompt renders it, so a model sees one format. */
  participantRoster: string;
  roles: string;
  /** Ids the model was actually shown, for enforcing the rosters afterwards. */
  allowedUserIds: string[];
  allowedRoleIds: string[];
};

/**
 * Builds the participant and role rosters for a stored meeting, matching what
 * notes generation showed the model at the time. Any flow that asks a model to
 * write mentions needs these, otherwise it can only produce plain names or
 * invent ids.
 *
 * Role lookup failure degrades to no roles rather than failing the caller: a
 * correction that cannot add a role mention is much better than one that errors.
 */
export const buildMentionRosters = async (
  meeting: Pick<MeetingHistory, "guildId" | "ownershipScope" | "participants">,
): Promise<MentionRosters> => {
  const participants = meeting.participants ?? [];

  let mentionableRoles: Array<{ id: string; name: string }> = [];
  if (!isPersonalMeeting(meeting)) {
    try {
      const roles = await listGuildRolesCached(meeting.guildId);
      mentionableRoles = roles
        .filter((role) => isMentionableRole(role, meeting.guildId))
        .map((role) => ({ id: role.id, name: role.name }));
    } catch (error) {
      console.warn(
        `Could not resolve roles for guildId=${meeting.guildId}`,
        error,
      );
    }
  }

  const promptRoles = selectRolesForPrompt(mentionableRoles, participants);

  return {
    participantRoster:
      formatParticipantRoster(
        participants,
        new Map(mentionableRoles.map((role) => [role.id, role.name])),
      ) ?? NO_PARTICIPANT_ROSTER_TEXT,
    roles:
      promptRoles.length > 0
        ? formatRoleRoster(mentionableRoles, participants)
        : NO_ROLES_AVAILABLE_TEXT,
    allowedUserIds: participants.map((participant) => participant.id),
    // Only what the prompt actually rendered, so the cap cannot let an unseen
    // id through the sanitizer.
    allowedRoleIds: promptRoles.map((role) => role.id),
  };
};
