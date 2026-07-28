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

export const resolveGuildRoleNames = async (
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
 * Timeline events carry chat message text verbatim, so a participant who typed
 * a mention would otherwise surface a raw id on shared pages and the portal.
 */
export const resolveMentionsInTimelineEvents = <T extends { text: string }>(
  events: T[],
  resolveMentions: (text: string) => string,
): T[] =>
  events.map((event) => ({ ...event, text: resolveMentions(event.text) }));

/**
 * Builds a rewriter from role names the caller already has. Cross-guild list
 * endpoints use this so they can fetch role maps once per guild, in batches,
 * instead of once per meeting.
 */
export type MentionReplacer = {
  /** For consumers that show the result verbatim: plain React text, titles, model context. */
  toText: (text: string) => string;
  /** For consumers that parse the result as Markdown, where a name like `[x](y)` would become a link. */
  toMarkdown: (text: string) => string;
};

export const buildMeetingMentionReplacer = (
  meeting: MentionSource,
  roleNamesByGuildId: Map<string, Map<string, string>>,
): MentionReplacer => {
  const participants = buildParticipantMap(meeting.participants);
  const roleNames = isPersonalMeeting(meeting)
    ? new Map<string, string>()
    : (roleNamesByGuildId.get(meeting.guildId) ?? new Map<string, string>());
  return {
    toText: (text) =>
      replaceDiscordMentionsWithDisplayNames(text, participants, roleNames),
    toMarkdown: (text) =>
      replaceDiscordMentionsWithDisplayNames(text, participants, roleNames, {
        forMarkdown: true,
      }),
  };
};

/**
 * Builds a rewriter that turns Discord user and role mentions into readable
 * `@Name` text. Role names are resolved once per meeting so a caller can
 * rewrite notes, transcript, and summary without extra Discord calls.
 * Personal meetings have no guild, so they skip role resolution entirely.
 */
export const createMeetingMentionReplacer = async (
  meeting: MentionSource,
): Promise<MentionReplacer> => {
  if (isPersonalMeeting(meeting)) {
    return buildMeetingMentionReplacer(meeting, new Map());
  }
  const roleNames = await resolveGuildRoleNames(meeting.guildId);
  return buildMeetingMentionReplacer(
    meeting,
    new Map([[meeting.guildId, roleNames]]),
  );
};
