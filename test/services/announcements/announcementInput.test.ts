import { describe, expect, it } from "@jest/globals";
import { parseAnnouncement } from "../../../src/services/announcements/announcementInput";
import {
  AnnouncementInputError,
  type Announcement,
} from "../../../src/services/announcements/announcementTypes";

const FRONT_MATTER = [
  "id: incident-2026-11-04",
  "kind: incident",
  "title: Meetings not starting in some servers",
];

const markdown = (body: string, frontMatter: string[] = FRONT_MATTER) =>
  ["---", ...frontMatter, "---", body].join("\n");

const BODY = [
  "<!-- Replace this paragraph before sending. -->",
  "Some meetings did not start between **10:00** and **10:40 UTC**.",
  "",
  "<!--",
  "multi-line guidance",
  "-->",
  "We are investigating.",
].join("\n");

const EXPECTED: Announcement = {
  id: "incident-2026-11-04",
  kind: "incident",
  title: "Meetings not starting in some servers",
  body: [
    "Some meetings did not start between **10:00** and **10:40 UTC**.",
    "",
    "",
    "We are investigating.",
  ].join("\n"),
  fields: [],
};

const validJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: EXPECTED.id,
    kind: EXPECTED.kind,
    title: EXPECTED.title,
    body: EXPECTED.body,
    ...overrides,
  });

const problemsOf = (run: () => unknown): string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof AnnouncementInputError) return error.problems;
    throw error;
  }
  throw new Error("expected an AnnouncementInputError");
};

describe("parseAnnouncement", () => {
  it("reads front matter and the comment-free Markdown body", () => {
    const result = parseAnnouncement(markdown(`\n${BODY}\n\n`), "markdown");

    expect(result.announcement).toEqual(EXPECTED);
    expect(result.warnings).toEqual([]);
  });

  it("accepts a byte order mark before the front matter", () => {
    const result = parseAnnouncement(`\uFEFF${markdown(BODY)}`, "markdown");

    expect(result.announcement).toEqual(EXPECTED);
  });

  it("reads the equivalent JSON to the same announcement", () => {
    expect(parseAnnouncement(validJson(), "json").announcement).toEqual(
      EXPECTED,
    );
  });

  it("reads optional fields from front matter", () => {
    const { announcement } = parseAnnouncement(
      markdown("Body.", [
        ...FRONT_MATTER,
        "fields:",
        "  - name: Started",
        "    value: 10:00 UTC",
        "    inline: true",
      ]),
      "markdown",
    );

    expect(announcement.fields).toEqual([
      { name: "Started", value: "10:00 UTC", inline: true },
    ]);
  });

  it.each([
    ["id", { id: "Incident_2026" }],
    ["id", { id: "incident--2026" }],
    ["kind", { kind: "outage" }],
    ["title", { title: "   " }],
    ["body", { body: "<!-- only guidance -->" }],
  ])("rejects an invalid %s", (field, overrides) => {
    const problems = problemsOf(() =>
      parseAnnouncement(validJson(overrides), "json"),
    );

    expect(problems).toEqual([expect.stringMatching(new RegExp(`^${field}:`))]);
  });

  it("rejects an empty Markdown body", () => {
    const problems = problemsOf(() =>
      parseAnnouncement(markdown("\n  \n"), "markdown"),
    );

    expect(problems).toEqual([expect.stringMatching(/^body:/)]);
  });

  it("names every unfilled placeholder", () => {
    const problems = problemsOf(() =>
      parseAnnouncement(
        markdown("Next update at {{next_update}}. Ask {{ support_contact }}."),
        "markdown",
      ),
    );

    expect(problems).toEqual([
      expect.stringContaining("next_update"),
      expect.stringContaining("support_contact"),
    ]);
  });

  it.each(["@everyone", "@here", "<@123>", "<@!123>", "<@&123>", "<#123>"])(
    "rejects the mention %s wherever it appears",
    (mention) => {
      const placements = [
        { title: `Heads up ${mention}` },
        { body: `Heads up ${mention}` },
        { fields: [{ name: "Who", value: `Heads up ${mention}` }] },
        { fields: [{ name: `Heads up ${mention}`, value: "Everyone" }] },
      ];

      for (const placement of placements) {
        const problems = problemsOf(() =>
          parseAnnouncement(validJson(placement), "json"),
        );
        expect(problems).toEqual([expect.stringContaining(mention)]);
      }
    },
  );

  it.each([17, 20])("warns about a %i-digit snowflake-shaped run", (length) => {
    const { warnings } = parseAnnouncement(
      validJson({ body: `See ${"1".repeat(length)} for details.` }),
      "json",
    );

    expect(warnings).toEqual([expect.stringContaining("snowflake")]);
  });

  it.each([16, 21])("does not warn about a %i-digit run", (length) => {
    const { warnings } = parseAnnouncement(
      validJson({ body: `See ${"1".repeat(length)} for details.` }),
      "json",
    );

    expect(warnings).toEqual([]);
  });

  it("rejects unknown front matter keys", () => {
    const problems = problemsOf(() =>
      parseAnnouncement(
        markdown("Body.", [...FRONT_MATTER, "audience: everyone"]),
        "markdown",
      ),
    );

    expect(problems).toEqual([expect.stringContaining("audience")]);
  });

  it("rejects a body key inside Markdown front matter", () => {
    const problems = problemsOf(() =>
      parseAnnouncement(
        markdown("Body.", [...FRONT_MATTER, "body: shadow"]),
        "markdown",
      ),
    );

    expect(problems).toEqual([expect.stringContaining("body")]);
  });

  it("rejects unknown JSON keys", () => {
    const problems = problemsOf(() =>
      parseAnnouncement(validJson({ audience: "everyone" }), "json"),
    );

    expect(problems).toEqual([expect.stringContaining("audience")]);
  });

  it("rejects Markdown without front matter", () => {
    const problems = problemsOf(() =>
      parseAnnouncement("Just a body.", "markdown"),
    );

    expect(problems).toEqual([expect.stringContaining("front matter")]);
  });

  it("rejects malformed front matter and malformed JSON", () => {
    expect(
      problemsOf(() =>
        parseAnnouncement(markdown("Body.", ["id: [unclosed"]), "markdown"),
      ),
    ).toEqual([expect.stringContaining("front matter")]);
    expect(problemsOf(() => parseAnnouncement("{", "json"))).toEqual([
      expect.stringContaining("JSON"),
    ]);
  });
});
