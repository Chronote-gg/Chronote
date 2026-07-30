import { describe, expect, test } from "@jest/globals";
import {
  collectMentionIds,
  mergeAllowedMentions,
  stripUnknownMentions,
} from "../mentionSanitizer";

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

describe("collectMentionIds", () => {
  test("separates user and role ids already present in notes", () => {
    expect(
      collectMentionIds(
        `- <@${USER_ID}> and <@!${USER_ID}> and <@&${ROLE_ID}> ship it.`,
      ),
    ).toEqual({ userIds: [USER_ID], roleIds: [ROLE_ID] });
  });

  test("returns empty lists for notes with no mentions", () => {
    expect(collectMentionIds("No assignments.")).toEqual({
      userIds: [],
      roleIds: [],
    });
  });

  test("used as a correction allowlist, keeps existing and blocks new mentions", () => {
    const currentNotes = `- <@&${ROLE_ID}> owns the rollout.`;
    const corrected = `- <@&${ROLE_ID}> owns the rollout, <@&${GUILD_ID}> review it, <@${USER_ID}> assists.`;

    expect(
      stripUnknownMentions(corrected, collectMentionIds(currentNotes)),
    ).toBe(`- <@&${ROLE_ID}> owns the rollout, review it, assists.`);
  });
});

describe("mergeAllowedMentions", () => {
  const ROLE_FROM_ROSTER = "300000000000000002";

  test("unions and dedupes both lists", () => {
    expect(
      mergeAllowedMentions(
        { userIds: [USER_ID], roleIds: [ROLE_ID] },
        { userIds: [USER_ID], roleIds: [ROLE_FROM_ROSTER] },
      ),
    ).toMatchObject({
      userIds: [USER_ID],
      roleIds: [ROLE_ID, ROLE_FROM_ROSTER],
    });
  });

  test("lets a correction add a roster mention while still blocking invented ids", () => {
    // The behaviour the correction flow depends on: a role that was never in
    // the notes is allowed because the roster offered it, but a guild id
    // (@everyone) and an unknown id are still removed.
    const currentNotes = `- <@&${ROLE_ID}> owns the rollout.`;
    const corrected =
      `- <@&${ROLE_ID}> owns the rollout, <@&${ROLE_FROM_ROSTER}> reviews it, ` +
      `<@&${GUILD_ID}> read this, <@299999999999999999> helps.`;

    const allowed = mergeAllowedMentions(collectMentionIds(currentNotes), {
      userIds: [],
      roleIds: [ROLE_FROM_ROSTER],
    });

    expect(stripUnknownMentions(corrected, allowed)).toBe(
      `- <@&${ROLE_ID}> owns the rollout, <@&${ROLE_FROM_ROSTER}> reviews it, read this, helps.`,
    );
  });
});
