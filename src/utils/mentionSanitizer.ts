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
 */
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
