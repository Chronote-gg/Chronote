// Captures an optional single trailing space so a removed mention does not
// leave a double space behind.
const MENTION_PATTERN = /<@([!&]?)(\d+)>( ?)/g;
const ROLE_MENTION_SIGIL = "&";

export type AllowedMentions = {
  userIds: string[];
  roleIds: string[];
  /** Names for ids that exist but were not shown to the model, if known. */
  roleNamesById?: Map<string, string>;
};

/**
 * Rewrites mentions the model was not given into plain text.
 *
 * The notes prompt tells the model to copy mention strings verbatim from the
 * rosters, but a model can still invent an id or reach for @everyone. An
 * unknown id renders as a broken mention in Discord and the guild id renders
 * as @everyone, so generated notes are checked against the rosters before they
 * are persisted and posted rather than trusting the instruction alone.
 *
 * Deliberately limited to mention syntax. Literal "@everyone" text is prose,
 * not a mention: it never pings from an embed and may legitimately describe
 * what someone said. Rewriting it would be content mangling on a keyword
 * match. The eval grader still flags it, because prompt adherence is a
 * different question from what is safe to persist.
 */
/**
 * The mention ids already present in a piece of text.
 *
 * Note edits use this as their allowlist: a correction makes minimal changes to
 * notes whose mentions were already validated when generated, so anything that
 * was not there before is something the edit introduced. Deriving the list from
 * the text needs no Discord lookup, which matters because a failed role fetch
 * would otherwise look like "no roles are valid" and strip real mentions out of
 * the notes.
 */
export const collectMentionIds = (text: string): AllowedMentions => {
  const userIds = new Set<string>();
  const roleIds = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const [, sigil, id] = match;
    (sigil === ROLE_MENTION_SIGIL ? roleIds : userIds).add(id);
  }
  return { userIds: Array.from(userIds), roleIds: Array.from(roleIds) };
};

/**
 * Unions two allowlists. Corrections need both what the notes already contained
 * and what the rosters offered, so an edit can add a roster-backed mention
 * without a mention that predates the rosters being stripped.
 */
export const mergeAllowedMentions = (
  ...lists: AllowedMentions[]
): AllowedMentions => ({
  userIds: Array.from(new Set(lists.flatMap((list) => list.userIds))),
  roleIds: Array.from(new Set(lists.flatMap((list) => list.roleIds))),
  roleNamesById: new Map(
    lists.flatMap((list) => Array.from(list.roleNamesById ?? [])),
  ),
});

export const stripUnknownMentions = (
  notes: string,
  allowed: AllowedMentions,
): string => {
  if (!notes) return notes;
  const allowedUserIds = new Set(allowed.userIds);
  const allowedRoleIds = new Set(allowed.roleIds);

  return notes.replace(
    MENTION_PATTERN,
    (match, sigil: string, id: string, trailingSpace: string) => {
      const isRole = sigil === ROLE_MENTION_SIGIL;
      const isAllowed = isRole
        ? allowedRoleIds.has(id)
        : allowedUserIds.has(id);
      if (isAllowed) return match;
      const knownName = isRole ? allowed.roleNamesById?.get(id) : undefined;
      return knownName ? `@${knownName}${trailingSpace}` : "";
    },
  );
};
