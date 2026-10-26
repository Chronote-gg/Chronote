/** @jest-environment node */
import {
  transitionOwnedMeetingHistoryService,
  saveOwnedMeetingHistoryService,
} from "../../src/services/meetingHistoryService";
import { saveMeetingStartToDatabase } from "../../src/commands/saveMeetingHistory";
import { renewActiveMeetingLease } from "../../src/db";
import type { MeetingData } from "../../src/types/meeting-data";
import { history } from "../deployment/controlFixtures";
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

describe("owned recording history", () => {
  beforeEach(() => resetMockStore());
  function fixture(
    status: "starting" | "processing" | "complete" = "processing",
  ) {
    const row = {
      ...history,
      status,
      notesVersion: 3,
      notes: "Existing",
      captureMarker: "preserved",
    };
    getMockStore().meetingHistoryByGuild.set(row.guildId, [row]);
    const meeting = {
      reservation: {
        sessionMode: "meeting",
        guildId: row.guildId,
        meetingId: row.meetingId,
        ownerInstanceId: row.ownerInstanceId,
        executionVersion: row.executionVersion,
        historyKey: {
          guildId: row.guildId,
          channelId_timestamp: row.channelId_timestamp,
        },
      },
    } as unknown as MeetingData;
    return { row, meeting };
  }
  it("lateInitialSaveCannotRegressTerminalHistory", async () => {
    const { row, meeting } = fixture("complete");
    await expect(saveMeetingStartToDatabase(meeting)).rejects.toThrow(
      "ownership",
    );
    expect(getMockStore().meetingHistoryByGuild.get(row.guildId)?.[0]).toEqual(
      row,
    );
  });
  it("conditional terminal metadata retains attempt fields and unrelated capture metadata", async () => {
    const { row, meeting } = fixture();
    await saveOwnedMeetingHistoryService(meeting, {
      ...row,
      status: "complete",
      notes: "Final notes",
    });
    expect(
      getMockStore().meetingHistoryByGuild.get(row.guildId)?.[0],
    ).toMatchObject({
      status: "complete",
      notes: "Final notes",
      notesVersion: 3,
      ownerInstanceId: "old",
      executionVersion: 1,
      captureMarker: "preserved",
    });
    await expect(
      transitionOwnedMeetingHistoryService(meeting, { status: "failed" }, [
        "processing",
      ]),
    ).rejects.toThrow("changed");
  });
  it("new owner version fences both progress and terminal saves", async () => {
    const { row, meeting } = fixture();
    row.executionVersion = 2;
    row.ownerInstanceId = "recovery";
    await expect(
      saveOwnedMeetingHistoryService(meeting, { ...row, status: "complete" }),
    ).rejects.toThrow("changed");
    expect(getMockStore().meetingHistoryByGuild.get(row.guildId)?.[0]).toBe(
      row,
    );
    expect(row.status).toBe("processing");
  });
  it("unreserved canonical saves never fall through to a generic Put", async () => {
    await expect(saveMeetingStartToDatabase({} as MeetingData)).rejects.toThrow(
      "reservation",
    );
  });
  it("expiredOwnerCannotRenewAfterRecovery", async () => {
    const now = Math.floor(Date.now() / 1000);
    const lease = {
      guildId: "guild",
      meetingId: "meeting",
      ownerInstanceId: "old",
      executionVersion: 1,
      sessionMode: "meeting" as const,
      voiceChannelId: "voice",
      textChannelId: "text",
      isAutoRecording: false,
      leaseExpiresAt: now - 1,
      expiresAt: now + 120,
      createdAt: "start",
      updatedAt: "start",
    };
    getMockStore().activeMeetingLeases.set("guild", lease);
    const renew = () =>
      renewActiveMeetingLease(
        "guild",
        "meeting",
        "old",
        now + 30,
        new Date().toISOString(),
        now + 150,
        { status: "processing" },
        { executionVersion: 1, sessionMode: "meeting" },
      );
    expect(await renew()).toBe(false);
    lease.leaseExpiresAt = now + 30;
    lease.executionVersion = 2;
    lease.ownerInstanceId = "recovery";
    expect(await renew()).toBe(false);
    expect(lease.executionVersion).toBe(2);
    lease.ownerInstanceId = "old";
    lease.executionVersion = 1;
    expect(await renew()).toBe(true);
  });
});
