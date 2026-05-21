import { describe, expect, test } from "@jest/globals";
import {
  buildMeetingLinkForLocation,
  parsePortalMeetingLink,
} from "../portalLinks";

describe("portalLinks", () => {
  test("parses portal meeting links", () => {
    const result = parsePortalMeetingLink(
      "https://chronote.test/portal/meetings/guild-1/voice-1%232026-01-02T00%3A00%3A00.000Z?eventId=line-9&fullScreen=true",
      "https://chronote.test",
    );

    expect(result).toEqual({
      serverId: "guild-1",
      meetingId: "voice-1#2026-01-02T00:00:00.000Z",
      eventId: "line-9",
      fullScreen: true,
    });
  });

  test("parses legacy server library meeting links", () => {
    const result = parsePortalMeetingLink(
      "https://chronote.test/portal/server/guild-1/library?meetingId=meet-1&eventId=line-9&fullScreen=true",
      "https://chronote.test",
    );

    expect(result).toEqual({
      serverId: "guild-1",
      meetingId: "meet-1",
      eventId: "line-9",
      fullScreen: true,
    });
  });

  test("ignores links without meetingId", () => {
    const result = parsePortalMeetingLink(
      "https://chronote.test/portal/server/guild-1/library",
      "https://chronote.test",
    );

    expect(result).toBeNull();
  });

  test("builds meeting links on the current path", () => {
    const href = buildMeetingLinkForLocation({
      pathname: "/portal/server/guild-1/ask",
      search: "?conversationId=c1&list=mine",
      meetingId: "meet-5",
      eventId: "line-22",
      fullScreen: true,
    });

    expect(href).toBe(
      "/portal/server/guild-1/ask?conversationId=c1&list=mine&meetingId=meet-5&eventId=line-22&fullScreen=true",
    );
  });
});
