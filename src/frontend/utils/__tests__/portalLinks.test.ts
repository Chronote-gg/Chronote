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

  test("ignores malformed direct meeting path encoding", () => {
    const result = parsePortalMeetingLink(
      "https://chronote.test/portal/meetings/guild-1/%E0%A4%A",
      "https://chronote.test",
    );

    expect(result).toBeNull();
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

test("parses unified drawer links with encoded composite IDs", () => {
  expect(
    parsePortalMeetingLink(
      "/portal/meetings?scope=all&meetingServerId=personal%3Au&meetingId=voice%23date&eventId=e&fullScreen=1",
      "https://chronote.test",
    ),
  ).toEqual({
    serverId: "personal:u",
    meetingId: "voice#date",
    eventId: "e",
    fullScreen: true,
  });
  expect(
    parsePortalMeetingLink(
      "/portal/meetings?meetingId=m",
      "https://chronote.test",
    ),
  ).toBeNull();
});
test("adds the drawer server without replacing the source", () => {
  expect(
    buildMeetingLinkForLocation({
      pathname: "/portal/meetings",
      search: "?scope=personal",
      meetingServerId: "personal:u",
      meetingId: "voice#date",
    }),
  ).toBe(
    "/portal/meetings?scope=personal&meetingId=voice%23date&meetingServerId=personal%3Au",
  );
});
