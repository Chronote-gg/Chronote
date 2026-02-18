import {
  buildSharedMeetingPayloadService,
  resolveSharedMeetingTitle,
  sanitizeMeetingEventsForShare,
} from "../../src/services/meetingSharePayloadService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";

describe("meetingSharePayloadService", () => {
  beforeEach(() => {
    resetMockStore();
  });

  it("resolves a title from meetingName/summaryLabel/summarySentence", () => {
    expect(
      resolveSharedMeetingTitle({
        meetingName: "Weekly sync",
        summaryLabel: "Label",
        summarySentence: "Sentence",
      }),
    ).toBe("Weekly sync");
    expect(
      resolveSharedMeetingTitle({
        meetingName: " ",
        summaryLabel: "Sprint planning",
        summarySentence: "Sentence",
      }),
    ).toBe("Sprint planning");
    expect(
      resolveSharedMeetingTitle({
        meetingName: " ",
        summaryLabel: " ",
        summarySentence: "One sentence summary",
      }),
    ).toBe("One sentence summary");
  });

  it("sanitizes meeting events to avoid leaking ids and message ids", () => {
    const sanitized = sanitizeMeetingEventsForShare([
      {
        id: "voice:123:2026-01-01",
        type: "voice",
        time: "0:01",
        speaker: "User",
        text: "Hello",
      },
      {
        id: "chat:123:456",
        type: "chat",
        time: "0:02",
        speaker: "User",
        text: "Hi",
        messageId: "456",
      },
    ]);

    expect(sanitized[0]?.id).toBe("evt:0000:voice");
    expect(sanitized[1]?.id).toBe("evt:0001:chat");
    expect((sanitized[1] as { messageId?: string }).messageId).toBeUndefined();
  });

  it("builds a shared payload without messageId fields in events", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const history = store.meetingHistoryByGuild.get(guildId)?.[0];
    expect(history).toBeDefined();
    if (!history) return;

    const payload = await buildSharedMeetingPayloadService(history);
    expect(payload.meeting.title).toBeTruthy();
    expect(Array.isArray(payload.meeting.events)).toBe(true);
    expect(payload.meeting.events.length).toBeGreaterThan(0);

    const hasMessageId = payload.meeting.events.some(
      (event) => (event as { messageId?: string }).messageId,
    );
    expect(hasMessageId).toBe(false);
    expect(
      payload.meeting.events.every((event) => event.id.startsWith("evt:")),
    ).toBe(true);
  });
});
