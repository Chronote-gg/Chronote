/** @jest-environment node */
import {
  getMeetingHistoryService,
  listRecentMeetingsForGuildService,
  updateMeetingArchiveService,
} from "../../src/services/meetingHistoryService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";

describe("meetingHistoryService archive", () => {
  beforeEach(() => {
    resetMockStore();
  });

  it("filters archived meetings by default and includes them when requested", async () => {
    const guildId = getMockStore().userGuilds[0].id;
    const activeMeetings = await listRecentMeetingsForGuildService(guildId, 10);
    expect(activeMeetings.length).toBeGreaterThan(0);
    expect(activeMeetings.every((meeting) => !meeting.archivedAt)).toBe(true);

    const allMeetings = await listRecentMeetingsForGuildService(guildId, 10, {
      includeArchived: true,
    });
    expect(allMeetings.length).toBeGreaterThanOrEqual(activeMeetings.length);
    expect(allMeetings.some((meeting) => meeting.archivedAt)).toBe(true);
  });

  it("archives and unarchives a meeting", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const meeting = store.meetingHistoryByGuild.get(guildId)?.[0];
    expect(meeting).toBeDefined();
    if (!meeting) return;

    const archived = await updateMeetingArchiveService({
      guildId,
      channelId_timestamp: meeting.channelId_timestamp,
      archived: true,
      archivedByUserId: "tester",
    });
    expect(archived).toBe(true);

    const updated = await getMeetingHistoryService(
      guildId,
      meeting.channelId_timestamp,
    );
    expect(updated?.archivedAt).toBeTruthy();
    expect(updated?.archivedByUserId).toBe("tester");

    const unarchived = await updateMeetingArchiveService({
      guildId,
      channelId_timestamp: meeting.channelId_timestamp,
      archived: false,
      archivedByUserId: "tester",
    });
    expect(unarchived).toBe(true);

    const cleared = await getMeetingHistoryService(
      guildId,
      meeting.channelId_timestamp,
    );
    expect(cleared?.archivedAt).toBeUndefined();
    expect(cleared?.archivedByUserId).toBeUndefined();
  });
});
