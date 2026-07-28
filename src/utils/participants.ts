import { Guild, GuildMember, User } from "discord.js";
import { Participant } from "../types/participants";

// Accept both legacy (<@!123>) and current (<@123>) mention formats.
// Outgoing mentions normalize to <@id>, but we still parse stored legacy values.
const DISCORD_MENTION_REGEX = /^<@!?(\d+)>$/;
// Matches user (<@123>, <@!123>) and role (<@&123>) mentions in note bodies.
const DISCORD_ANY_MENTION_PATTERN = /<@([!&]?)(\d+)>/g;
const ROLE_MENTION_SIGIL = "&";
const DISCORD_PROFILE_REGEX =
  /https?:\/\/(?:ptb\.|canary\.)?discord\.com\/users\/(\d+)/i;
const DISCORD_ID_REGEX = /^\d{15,20}$/;

export function formatUserMention(userId: string): string {
  return `<@${userId}>`;
}

export function formatRoleMention(roleId: string): string {
  return `<@&${roleId}>`;
}

export function extractDiscordUserId(reference: string): string | undefined {
  const trimmed = reference.trim();
  const mentionMatch = trimmed.match(DISCORD_MENTION_REGEX);
  if (mentionMatch) return mentionMatch[1];
  const profileMatch = trimmed.match(DISCORD_PROFILE_REGEX);
  if (profileMatch) return profileMatch[1];
  if (DISCORD_ID_REGEX.test(trimmed)) return trimmed;
  return undefined;
}

export function resolveAttendeeDisplayName(
  attendee: string,
  participants: Map<string, Participant>,
): string {
  const id = extractDiscordUserId(attendee);
  if (!id) return attendee;
  const participant = participants.get(id);
  if (!participant) return attendee;
  return formatParticipantLabel(participant, {
    includeUsername: false,
    fallbackName: attendee,
  });
}

const formatResolvedMention = (name: string): string =>
  `@${name.replace(/^@+/, "")}`;

/**
 * Rewrites Discord user and role mentions into readable `@Name` text for
 * surfaces that cannot render mentions (web portal, MCP, Notion, Markdown
 * export). Unknown ids are left untouched so raw mentions never become
 * misleading names.
 */
export function replaceDiscordMentionsWithDisplayNames(
  text: string,
  participants: Map<string, Participant>,
  roleNamesById: Map<string, string> = new Map(),
): string {
  if (!text) return text;
  return text.replace(
    DISCORD_ANY_MENTION_PATTERN,
    (match, sigil: string, id: string) => {
      if (sigil === ROLE_MENTION_SIGIL) {
        const roleName = roleNamesById.get(id);
        return roleName ? formatResolvedMention(roleName) : match;
      }
      const participant = participants.get(id);
      if (!participant) return match;
      return formatResolvedMention(
        getParticipantPreferredName(participant, id) ?? id,
      );
    },
  );
}

export async function buildParticipantSnapshot(
  guild: Guild,
  userId: string,
): Promise<Participant | undefined> {
  try {
    const member =
      guild.members.cache.get(userId) || (await guild.members.fetch(userId));
    return fromMember(member);
  } catch (error) {
    // Fallback to user cache if member fetch fails (e.g., user left)
    const user = guild.client.users.cache.get(userId);
    if (user) {
      return fromUser(user);
    }
    console.warn(`Could not resolve participant for userId=${userId}`, error);
    return undefined;
  }
}

export function getParticipantPreferredName(
  participant?: Participant,
  fallback?: string,
): string | undefined {
  return (
    participant?.serverNickname ||
    participant?.displayName ||
    participant?.username ||
    participant?.tag ||
    fallback
  );
}

export function getParticipantUsername(
  participant?: Participant,
  fallback?: string,
): string | undefined {
  return participant?.username || participant?.tag || fallback;
}

export function formatParticipantLabel(
  participant?: Participant,
  options?: {
    includeUsername?: boolean;
    fallbackName?: string;
    fallbackUsername?: string;
  },
): string {
  const name = getParticipantPreferredName(participant, options?.fallbackName);
  const username = getParticipantUsername(
    participant,
    options?.fallbackUsername,
  );
  if (options?.includeUsername && username) {
    const handle = username.startsWith("@") ? username.slice(1) : username;
    if (name && handle && name.toLowerCase() !== handle.toLowerCase()) {
      return `${name} (@${handle})`;
    }
    return name ?? `@${handle}`;
  }
  return name ?? username ?? "Unknown";
}

export function fromMember(member: GuildMember): Participant {
  // @everyone is on every member and carries no signal, so it is dropped here.
  const roleIds = member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .map((role) => role.id);
  return {
    id: member.user.id,
    username: member.user.username,
    displayName: member.user.globalName ?? undefined,
    serverNickname: member.nickname ?? undefined,
    tag: member.user.tag,
    roleIds: roleIds.length > 0 ? roleIds : undefined,
  };
}

export function fromUser(user: User): Participant {
  return {
    id: user.id,
    username: user.username,
    displayName: user.globalName ?? undefined,
    tag: user.tag,
  };
}
