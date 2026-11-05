/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAnnouncementEmbed } from "../../../src/services/announcements/announcementEmbed";
import { parseAnnouncement } from "../../../src/services/announcements/announcementInput";
import { AnnouncementInputError } from "../../../src/services/announcements/announcementTypes";

const TEMPLATES = join(__dirname, "../../../docs/operations/announcements");

const HOUSE_RULES = `House rules for public notices:
- The next update is a clock time with timezone. "Tonight" is not a time.
- No operational figures: no server counts, share of users, costs, ids, or internal names.
- Plain and professional. State what happened and what is being done. One apology at most.
- Say recordings and notes are safe only when that is verified.
- BASIC approves the final text and runs the send.`;

const templates: [string, string, string[]][] = [
  [
    "incident.md",
    "incident",
    [
      "date",
      "symptom",
      "status",
      "what_users_see",
      "who_is_affected",
      "data_statement",
      "what_we_are_doing",
      "next_update_time_with_timezone",
      "how_to_get_help",
    ],
  ],
  [
    "incident-resolved.md",
    "resolved",
    [
      "date",
      "symptom",
      "what_was_fixed_and_when",
      "action_needed_or_none",
      "how_to_reach_us",
    ],
  ],
];

describe.each(templates)("%s", (file, kind, placeholders) => {
  // A Windows checkout may carry CRLF line endings.
  const content = readFileSync(join(TEMPLATES, file), "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("starts its body with the house rules comment", () => {
    expect(content).toContain(`<!--\n${HOUSE_RULES}\n-->`);
  });

  it("refuses to parse unfilled, naming exactly its placeholders", () => {
    let problems: string[] = [];
    try {
      parseAnnouncement(content, "markdown");
    } catch (error) {
      if (!(error instanceof AnnouncementInputError)) throw error;
      problems = error.problems;
    }
    expect(problems).toEqual(
      placeholders.map((name) => `unfilled placeholder {{${name}}}`),
    );
  });

  it("parses and renders within limits once filled", () => {
    const filled = content
      .replace(/\{\{date\}\}/g, "2026-11-04")
      .replace(/\{\{[^{}]*\}\}/g, "x");
    const { announcement, warnings } = parseAnnouncement(filled, "markdown");
    expect(announcement).toMatchObject({ id: `${kind}-2026-11-04`, kind });
    expect(announcement.body).not.toContain("House rules");
    expect(warnings).toEqual([]);
    expect(() =>
      renderAnnouncementEmbed(announcement, new Date("2026-11-04T12:00:00Z")),
    ).not.toThrow();
  });
});
