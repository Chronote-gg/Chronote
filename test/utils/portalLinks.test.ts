import { describe, expect, test } from "@jest/globals";
import { buildPortalMeetingUrl } from "../../src/utils/portalLinks";

describe("portalLinks", () => {
  test("builds direct meeting detail URLs", () => {
    const url = buildPortalMeetingUrl({
      baseUrl: "https://app.example.com/",
      guildId: "guild-1",
      meetingId: "voice-1#2026-01-02T00:00:00.000Z",
      eventId: "line-9",
      fullScreen: true,
    });

    expect(url).toBe(
      "https://app.example.com/portal/meetings/guild-1/voice-1%232026-01-02T00%3A00%3A00.000Z?eventId=line-9&fullScreen=true",
    );
  });
});
