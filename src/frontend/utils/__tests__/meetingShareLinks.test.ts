import { buildMeetingShareUrl } from "../meetingShareLinks";

describe("meetingShareLinks", () => {
  it("builds a meeting share URL", () => {
    const url = buildMeetingShareUrl({
      origin: "https://example.com",
      serverId: "123",
      shareId: "sh_abc",
    });
    expect(url).toBe("https://example.com/share/meeting/123/sh_abc");
  });
});
