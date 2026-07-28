import { describe, expect, test } from "@jest/globals";
import {
  extractRoleMentionIds,
  extractUserMentionIds,
  gradeMentions,
} from "../roleMentionGraders";

const GUILD_ID = "100000000000000001";
const USER_A = "200000000000000001";
const ROLE_DESIGN = "300000000000000001";
const ROLE_MODS = "300000000000000002";

const gradeValue = (
  grades: ReturnType<typeof gradeMentions>,
  name: string,
): number | undefined => grades.find((grade) => grade.name === name)?.value;

describe("mention extraction", () => {
  test("separates user mentions from role mentions", () => {
    const notes = `- <@${USER_A}> ships the doc, <@&${ROLE_DESIGN}> reviews it.`;

    expect(extractUserMentionIds(notes)).toEqual([USER_A]);
    expect(extractRoleMentionIds(notes)).toEqual([ROLE_DESIGN]);
  });

  test("accepts legacy nickname mentions and dedupes repeats", () => {
    const notes = `<@!${USER_A}> and <@${USER_A}> and <@&${ROLE_MODS}> twice <@&${ROLE_MODS}>`;

    expect(extractUserMentionIds(notes)).toEqual([USER_A]);
    expect(extractRoleMentionIds(notes)).toEqual([ROLE_MODS]);
  });

  test("ignores mentions Discord will not render", () => {
    expect(
      extractRoleMentionIds(`Use \`<@&${ROLE_DESIGN}>\` in the template.`),
    ).toEqual([]);
    expect(
      extractRoleMentionIds(
        "```\nping <@&300000000000000002> here\n```\nnothing else",
      ),
    ).toEqual([]);
    expect(
      extractRoleMentionIds(`Escaped \\<@&${ROLE_DESIGN}> stays text.`),
    ).toEqual([]);
  });

  test("still counts a rendering mention alongside a code span", () => {
    expect(
      extractRoleMentionIds(
        `\`<@&${ROLE_MODS}>\` is the syntax, <@&${ROLE_DESIGN}> owns it.`,
      ),
    ).toEqual([ROLE_DESIGN]);
  });

  test("repeated calls are not affected by regex state", () => {
    const notes = `<@&${ROLE_DESIGN}>`;

    expect(extractRoleMentionIds(notes)).toEqual([ROLE_DESIGN]);
    expect(extractRoleMentionIds(notes)).toEqual([ROLE_DESIGN]);
  });
});

describe("gradeMentions", () => {
  const baseInput = {
    allowedUserIds: [USER_A],
    allowedRoleIds: [ROLE_DESIGN, ROLE_MODS],
    guildId: GUILD_ID,
  };

  test("passes when every mention comes from the roster", () => {
    const grades = gradeMentions({
      ...baseInput,
      notes: `<@${USER_A}> drafts it and <@&${ROLE_DESIGN}> reviews.`,
    });

    expect(gradeValue(grades, "role_mentions_resolvable")).toBe(1);
    expect(gradeValue(grades, "user_mentions_resolvable")).toBe(1);
    expect(gradeValue(grades, "no_broadcast_mention")).toBe(1);
  });

  test("fails a hallucinated role id", () => {
    const grades = gradeMentions({
      ...baseInput,
      notes: "<@&399999999999999999> should follow up.",
    });

    expect(gradeValue(grades, "role_mentions_resolvable")).toBe(0);
  });

  test("fails a hallucinated user id", () => {
    const grades = gradeMentions({
      ...baseInput,
      notes: "<@299999999999999999> should follow up.",
    });

    expect(gradeValue(grades, "user_mentions_resolvable")).toBe(0);
  });

  test("fails when the @everyone role id is mentioned", () => {
    const grades = gradeMentions({
      ...baseInput,
      notes: `<@&${GUILD_ID}> please read the notes.`,
    });

    expect(gradeValue(grades, "no_broadcast_mention")).toBe(0);
  });

  test.each([
    "Type `@everyone` to notify the server.",
    "```\n@here is how you ping\n```",
  ])("does not fail broadcast text Discord renders as code: %s", (notes) => {
    expect(
      gradeValue(
        gradeMentions({ ...baseInput, notes }),
        "no_broadcast_mention",
      ),
    ).toBe(1);
  });

  test.each(["@everyone should read this.", "@here is the recap."])(
    "fails literal broadcast text: %s",
    (notes) => {
      expect(
        gradeValue(
          gradeMentions({ ...baseInput, notes }),
          "no_broadcast_mention",
        ),
      ).toBe(0);
    },
  );

  test("passes clean notes with no mentions at all", () => {
    const grades = gradeMentions({ ...baseInput, notes: "No assignments." });

    expect(gradeValue(grades, "role_mentions_resolvable")).toBe(1);
    expect(gradeValue(grades, "user_mentions_resolvable")).toBe(1);
    expect(gradeValue(grades, "no_broadcast_mention")).toBe(1);
  });

  test("scores partial recall against expected mentions", () => {
    const grades = gradeMentions({
      ...baseInput,
      notes: `<@&${ROLE_DESIGN}> owns this.`,
      expectedRoleIds: [ROLE_DESIGN, ROLE_MODS],
      expectedUserIds: [USER_A],
    });

    expect(gradeValue(grades, "expected_role_recall")).toBe(0.5);
    expect(gradeValue(grades, "expected_user_recall")).toBe(0);
  });

  test("omits recall grades when a case does not declare expectations", () => {
    const grades = gradeMentions({ ...baseInput, notes: "Nothing assigned." });

    expect(gradeValue(grades, "expected_role_recall")).toBeUndefined();
    expect(gradeValue(grades, "expected_user_recall")).toBeUndefined();
  });
});
