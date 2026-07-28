const USER_MENTION_PATTERN = /<@!?(\d+)>/g;
const ROLE_MENTION_PATTERN = /<@&(\d+)>/g;
const BROADCAST_MENTION_PATTERN = /@(everyone|here)\b/;

const PASS = 1;
const FAIL = 0;

export type MentionGrade = {
  name: string;
  value: number;
  comment?: string;
};

export type MentionGradeInput = {
  notes: string;
  /** Ids the notes were allowed to mention, from the rosters given to the model. */
  allowedUserIds: string[];
  allowedRoleIds: string[];
  /** Guild id doubles as the @everyone role id, which must never be mentioned. */
  guildId?: string;
  /** Ids a curated case expects to appear. Omit to skip the recall grades. */
  expectedUserIds?: string[];
  expectedRoleIds?: string[];
};

const FENCED_CODE_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const ESCAPED_MENTION_PATTERN = /\\<@[!&]?\d+>/g;

/**
 * Discord renders a mention inside a code span, or one escaped with a
 * backslash, as literal text. Grading those as real mentions would let an
 * experiment report full recall on output where users see nothing, so they are
 * removed before ids are extracted.
 */
const stripNonRenderingMentions = (text: string): string =>
  text
    .replace(FENCED_CODE_PATTERN, " ")
    .replace(INLINE_CODE_PATTERN, " ")
    .replace(ESCAPED_MENTION_PATTERN, " ");

const extractIds = (text: string, pattern: RegExp): string[] => {
  // Fresh regex per call so the shared /g lastIndex never leaks between calls.
  const matches = stripNonRenderingMentions(text).matchAll(
    new RegExp(pattern.source, pattern.flags),
  );
  return Array.from(new Set(Array.from(matches, (match) => match[1])));
};

export const extractUserMentionIds = (text: string): string[] =>
  extractIds(text, USER_MENTION_PATTERN);

export const extractRoleMentionIds = (text: string): string[] =>
  extractIds(text, ROLE_MENTION_PATTERN);

const gradeResolvable = (
  name: string,
  emitted: string[],
  allowed: string[],
): MentionGrade => {
  const allowedSet = new Set(allowed);
  const unknown = emitted.filter((id) => !allowedSet.has(id));
  return {
    name,
    value: unknown.length === 0 ? PASS : FAIL,
    comment:
      unknown.length === 0
        ? undefined
        : `${unknown.length} mention(s) not present in the roster`,
  };
};

const gradeRecall = (
  name: string,
  emitted: string[],
  expected: string[],
): MentionGrade => {
  const emittedSet = new Set(emitted);
  const found = expected.filter((id) => emittedSet.has(id));
  return {
    name,
    value: expected.length === 0 ? PASS : found.length / expected.length,
    comment:
      found.length === expected.length
        ? undefined
        : `${expected.length - found.length} expected mention(s) missing`,
  };
};

/**
 * Deterministic grades for mention handling in generated notes. These catch the
 * failure mode that actually matters, a mention id the model invented rather
 * than copied, without spending a judge model on it.
 */
export const gradeMentions = (input: MentionGradeInput): MentionGrade[] => {
  const roleIds = extractRoleMentionIds(input.notes);
  const userIds = extractUserMentionIds(input.notes);

  const mentionsEveryoneRole = input.guildId
    ? roleIds.includes(input.guildId)
    : false;
  const grades: MentionGrade[] = [
    gradeResolvable("role_mentions_resolvable", roleIds, input.allowedRoleIds),
    gradeResolvable("user_mentions_resolvable", userIds, input.allowedUserIds),
    {
      name: "no_broadcast_mention",
      value:
        BROADCAST_MENTION_PATTERN.test(input.notes) || mentionsEveryoneRole
          ? FAIL
          : PASS,
      comment: mentionsEveryoneRole
        ? "mentioned the @everyone role id"
        : undefined,
    },
  ];

  if (input.expectedRoleIds) {
    grades.push(
      gradeRecall("expected_role_recall", roleIds, input.expectedRoleIds),
    );
  }
  if (input.expectedUserIds) {
    grades.push(
      gradeRecall("expected_user_recall", userIds, input.expectedUserIds),
    );
  }

  return grades;
};
