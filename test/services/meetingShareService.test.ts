import {
  getMeetingShareRecordByShareIdService,
  getMeetingShareStateForMeetingService,
  setMeetingShareVisibilityService,
} from "../../src/services/meetingShareService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";

describe("meetingShareService", () => {
  beforeEach(() => {
    resetMockStore();
  });

  it("returns private when meeting is not shared", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const meeting = store.meetingHistoryByGuild.get(guildId)?.[0];
    expect(meeting).toBeDefined();
    if (!meeting) return;

    const state = await getMeetingShareStateForMeetingService({
      guildId,
      meetingId: meeting.channelId_timestamp,
    });

    expect(state.visibility).toBe("private");
    expect(state.shareId).toBeUndefined();
  });

  it("creates a server share and reuses shareId for same visibility", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const meeting = store.meetingHistoryByGuild.get(guildId)?.[0];
    expect(meeting).toBeDefined();
    if (!meeting) return;

    const first = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "server",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
    });
    expect(first.visibility).toBe("server");
    expect(first.shareId).toBeTruthy();
    expect(first.rotated).toBe(false);

    const second = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "server",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
    });
    expect(second.visibility).toBe("server");
    expect(second.shareId).toBe(first.shareId);
    expect(second.rotated).toBe(false);
  });

  it("rotates shareId when forceRotate is true", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const meeting = store.meetingHistoryByGuild.get(guildId)?.[0];
    expect(meeting).toBeDefined();
    if (!meeting) return;

    const first = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "server",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
    });

    const rotated = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "server",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
      forceRotate: true,
    });

    expect(rotated.visibility).toBe("server");
    expect(rotated.shareId).toBeTruthy();
    expect(rotated.shareId).not.toBe(first.shareId);
    expect(rotated.rotated).toBe(true);

    const old = await getMeetingShareRecordByShareIdService({
      guildId,
      shareId: first.shareId ?? "",
    });
    expect(old).toBeUndefined();
  });

  it("switches visibility and rotates shareId", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const meeting = store.meetingHistoryByGuild.get(guildId)?.[0];
    expect(meeting).toBeDefined();
    if (!meeting) return;

    const serverShare = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "server",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
    });

    const publicShare = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "public",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
    });

    expect(publicShare.visibility).toBe("public");
    expect(publicShare.shareId).toBeTruthy();
    expect(publicShare.shareId).not.toBe(serverShare.shareId);
    expect(publicShare.rotated).toBe(true);
  });

  it("turns off sharing and deletes share records", async () => {
    const store = getMockStore();
    const guildId = store.userGuilds[0].id;
    const meeting = store.meetingHistoryByGuild.get(guildId)?.[0];
    expect(meeting).toBeDefined();
    if (!meeting) return;

    const shared = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "server",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
    });
    expect(shared.shareId).toBeTruthy();

    const off = await setMeetingShareVisibilityService({
      guildId,
      meetingId: meeting.channelId_timestamp,
      visibility: "private",
      sharedByUserId: store.user.id,
      sharedByTag: "MockUser#0001",
    });
    expect(off.visibility).toBe("private");
    expect(off.shareId).toBeUndefined();

    const check = await getMeetingShareRecordByShareIdService({
      guildId,
      shareId: shared.shareId ?? "",
    });
    expect(check).toBeUndefined();
  });
});
