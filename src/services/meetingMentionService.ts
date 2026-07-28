import type { MeetingHistory } from "../types/db";
import type { Participant } from "../types/participants";
import { isPersonalMeeting } from "../utils/meetingOwnership";
import { replaceDiscordMentionsWithDisplayNames } from "../utils/participants";
import { listGuildRolesCached } from "./discordCacheService";

export const buildParticipantMap = (participants?: Participant[]) =>
  new Map(
    (participants ?? []).map((participant) => [participant.id, participant]),
  );

type MentionSource = Pick<MeetingHistory, "guildId" | "ownershipScope"> & {
  participants?: Participant[];
};

const resolveGuildRoleNames = async (
  guildId: string,
): Promise<Map<string, string>> => {
  try {
    const roles = await listGuildRolesCached(guildId);
    const named = new Map<string, string>();
    for (const role of roles) {
      if (role.name) named.set(role.id, role.name);
    }
    return named;
  } catch (error) {
    // Role names are cosmetic. Losing them leaves raw mentions in the output,
    // which is far better than failing a meeting read on a Discord hiccup.
    console.warn(`Could not resolve roles for guildId=${guildId}`, error);
    return new Map();
  }
};

/**
 * Builds a rewriter that turns Discord user and role mentions into readable
 * `@Name` text. Role names are resolved once per meeting so a caller can
 * rewrite notes, transcript, and summary without extra Discord calls.
 * Personal meetings have no guild, so they skip role resolution entirely.
 */
export const createMeetingMentionReplacer = async (
  meeting: MentionSource,
): Promise<(text: string) => string> => {
  const participants = buildParticipantMap(meeting.participants);
  const roleNames = isPersonalMeeting(meeting)
    ? new Map<string, string>()
    : await resolveGuildRoleNames(meeting.guildId);
  return (text: string) =>
    replaceDiscordMentionsWithDisplayNames(text, participants, roleNames);
};
