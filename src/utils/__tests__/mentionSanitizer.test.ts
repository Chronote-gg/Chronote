import { describe, expect, test } from "@jest/globals";
import { stripUnknownMentions } from "../mentionSanitizer";

const GUILD_ID = "100000000000000001";
const USER_ID = "200000000000000001";
const ROLE_ID = "300000000000000001";
const DROPPED_ROLE_ID = "300000000000000009";

const allowed = { userIds: [USER_ID], roleIds: [ROLE_ID] };

describe("stripUnknownMentions", () => {
  test("keeps mentions that came from the rosters", () => {
    const notes = `- <@${USER_ID}> drafts it, <@&${ROLE_ID}> reviews.`;

    expect(stripUnknownMentions(notes, allowed)).toBe(notes);
  });

  test("removes an invented role id", () => {
    expect(
      stripUnknownMentions("- <@&399999999999999999> follows up.", allowed),
    ).toBe("- follows up.");
  });

  test("removes an invented user id", () => {
    expect(
      stripUnknownMentions("- <@299999999999999999> follows up.", allowed),
    ).toBe("- follows up.");
  });

  test("removes the @everyone role id", () => {
    expect(stripUnknownMentions(`- <@&${GUILD_ID}> read this.`, allowed)).toBe(
      "- read this.",
    );
  });

  test("falls back to a plain name for a real role the model was not shown", () => {
    const notes = `- <@&${DROPPED_ROLE_ID}> owns it.`;

    expect(
      stripUnknownMentions(notes, {
        ...allowed,
        roleNamesById: new Map([[DROPPED_ROLE_ID, "Alumni"]]),
      }),
    ).toBe("- @Alumni owns it.");
  });

  test("does not leave a double space behind a removed mention", () => {
    expect(
      stripUnknownMentions(
        `- <@&${GUILD_ID}> and <@${USER_ID}> ship it.`,
        allowed,
      ),
    ).toBe(`- and <@${USER_ID}> ship it.`);
  });

  test("handles legacy nickname mention syntax", () => {
    expect(stripUnknownMentions(`- <@!${USER_ID}> ships it.`, allowed)).toBe(
      `- <@!${USER_ID}> ships it.`,
    );
  });

  test("returns empty notes unchanged", () => {
    expect(stripUnknownMentions("", allowed)).toBe("");
  });
});
