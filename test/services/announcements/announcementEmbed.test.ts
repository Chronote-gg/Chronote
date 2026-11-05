import { describe, expect, it } from "@jest/globals";
import { problemsOf } from "./announcementTestHelpers";
import { renderAnnouncementEmbed } from "../../../src/services/announcements/announcementEmbed";
import type {
  Announcement,
  AnnouncementKind,
} from "../../../src/services/announcements/announcementTypes";

const NOW = new Date("2026-11-04T15:30:00.000Z");
const FOOTER =
  "Chronote operator notice. Server admins can turn these off in Chronote server settings.";

const announcement = (overrides: Partial<Announcement> = {}): Announcement => ({
  id: "incident-2026-11-04",
  kind: "incident",
  title: "Meetings not starting in some servers",
  body: "We are investigating.",
  fields: [],
  ...overrides,
});

describe("renderAnnouncementEmbed", () => {
  it("copies the text and stamps the fixed footer and time", () => {
    expect(renderAnnouncementEmbed(announcement(), NOW)).toEqual({
      title: "Meetings not starting in some servers",
      description: "We are investigating.",
      color: expect.any(Number),
      footer: { text: FOOTER },
      timestamp: "2026-11-04T15:30:00.000Z",
    });
  });

  it("omits fields when there are none", () => {
    expect(renderAnnouncementEmbed(announcement(), NOW)).not.toHaveProperty(
      "fields",
    );
  });

  it("includes fields when present", () => {
    const fields = [{ name: "Started", value: "10:00 UTC", inline: true }];

    expect(
      renderAnnouncementEmbed(announcement({ fields }), NOW).fields,
    ).toEqual(fields);
  });

  it("uses a different colour for each kind", () => {
    const kinds: AnnouncementKind[] = ["info", "incident", "resolved"];
    const colors = kinds.map(
      (kind) => renderAnnouncementEmbed(announcement({ kind }), NOW).color,
    );

    expect(new Set(colors).size).toBe(kinds.length);
  });

  it("rejects a description over 4096 characters", () => {
    const problems = problemsOf(() =>
      renderAnnouncementEmbed(announcement({ body: "a".repeat(4097) }), NOW),
    );

    expect(problems).toEqual([expect.stringContaining("description")]);
  });

  it("rejects an embed over 6000 characters in total", () => {
    const fields = [1, 2].map((index) => ({
      name: `Part ${index}`,
      value: "b".repeat(1000),
    }));

    const problems = problemsOf(() =>
      renderAnnouncementEmbed(
        announcement({ body: "a".repeat(4000), fields }),
        NOW,
      ),
    );

    expect(problems).toEqual([expect.stringContaining("6000")]);
  });
});
