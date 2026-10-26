/** @jest-environment node */
import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import { getMeetingHistoryRepository } from "../../src/repositories/meetingHistoryRepository";
import type { MeetingHistory } from "../../src/types/db";
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
  afterEach(() => jest.restoreAllMocks());

  function conflictFixture() {
    const base = fixture();
    const repository = getMeetingHistoryRepository();
    const transition = repository.transitionOwned.bind(repository);
    const read = jest.spyOn(repository, "getOwned");
    const writes = jest.spyOn(repository, "transitionOwned");
    const current = () => {
      const row = getMockStore().meetingHistoryByGuild.get(
        base.row.guildId,
      )?.[0];
      if (!row) throw new Error("Expected owned history");
      return row;
    };
    const replace = (patch: Partial<MeetingHistory>) => {
      const row = structuredClone({ ...current(), ...patch });
      getMockStore().meetingHistoryByGuild.set(row.guildId, [row]);
    };
    const edit = (revision: number) =>
      replace({
        updateDelivery: requestMeetingUpdateDelivery({
          history: current(),
          mutation: { kind: "rename", meetingName: "Edited " + revision },
          revision: "delivery-" + revision,
          now: 100,
          policy: { kind: "held", reason: "initial_publication_unsettled" },
        }),
        contentRevision: revision,
        contentMutation: {
          id: "synthetic-edit-" + revision,
          fingerprint: "a".repeat(64),
          fieldRevisions: { meetingName: revision },
        },
        meetingName: "Edited " + revision,
      });
    const terminal: MeetingHistory = {
      ...base.row,
      status: "complete",
      notes: "Generated notes",
      meetingName: "Generated title",
      summarySentence: "Generated summary",
    };
    return {
      ...base,
      read,
      writes,
      transition,
      current,
      replace,
      edit,
      terminal,
    };
  }

  it("remerges the original terminal fields after two canonical conflicts", async () => {
    const f = conflictFixture();
    f.writes.mockImplementation(async (input) => {
      if (f.writes.mock.calls.length <= 2) f.edit(f.writes.mock.calls.length);
      return f.transition(input);
    });
    const saved = await saveOwnedMeetingHistoryService(f.meeting, f.terminal);
    expect(f.writes).toHaveBeenCalledTimes(3);
    expect(saved).toMatchObject({
      status: "complete",
      meetingName: "Edited 2",
      notes: "Generated notes",
      summarySentence: "Generated summary",
    });
    expect(f.current()).toMatchObject({
      status: "complete",
      contentRevision: 2,
      meetingName: "Edited 2",
      notes: "Generated notes",
      summarySentence: "Generated summary",
    });
    expect(f.terminal.meetingName).toBe("Generated title");
  });

  it("exhausts three canonical transition attempts without a fourth read or save", async () => {
    const f = conflictFixture();
    f.writes.mockImplementation(async (input) => {
      f.edit(f.writes.mock.calls.length);
      return f.transition(input);
    });
    await expect(
      saveOwnedMeetingHistoryService(f.meeting, f.terminal),
    ).rejects.toThrow("fenced");
    expect(f.writes).toHaveBeenCalledTimes(3);
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(f.current()).toMatchObject({
      status: "processing",
      contentRevision: 3,
      meetingName: "Edited 3",
    });
  });

  it.each([
    { meetingId: "replacement" },
    { ownerInstanceId: "replacement" },
    { executionVersion: 2 },
    { status: "cancelled" },
    { summaryMessageId: "different-publication" },
    {
      canonicalWriter: {
        kind: "recording",
        ownerInstanceId: "other",
        executionVersion: 1,
      },
    },
  ] satisfies Partial<MeetingHistory>[])(
    "stops canonical retry when a noncanonical fence changes: %j",
    async (change) => {
      const f = conflictFixture();
      f.writes.mockImplementationOnce(async (input) => {
        f.edit(1);
        f.replace(change);
        return f.transition(input);
      });
      // Both statuses are allowed initially; a changed status still cannot be adopted.
      await expect(
        transitionOwnedMeetingHistoryService(
          f.meeting,
          { status: "cancelled" },
          ["processing", "cancelled"],
          0,
        ),
      ).rejects.toThrow();
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(f.current()).toMatchObject(change);
      expect(f.current().notes).toBe("Existing");
    },
  );

  it("does not retry an unchanged stale snapshot", async () => {
    const f = conflictFixture();
    f.writes.mockResolvedValueOnce("stale");
    await expect(
      saveOwnedMeetingHistoryService(f.meeting, f.terminal),
    ).rejects.toThrow("fenced");
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(f.current().status).toBe("processing");
  });

  it.each(["read", "transition"] as const)(
    "propagates a repository %s error without retry",
    async (boundary) => {
      const f = conflictFixture();
      const error = new Error("synthetic transport error");
      if (boundary === "read") f.read.mockRejectedValueOnce(error);
      else f.writes.mockRejectedValueOnce(error);
      await expect(
        saveOwnedMeetingHistoryService(f.meeting, f.terminal),
      ).rejects.toBe(error);
      expect(f.read).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveBeenCalledTimes(boundary === "read" ? 0 : 1);
      expect(f.current().status).toBe("processing");
    },
  );

  it.each(["read", "transition", "reread"] as const)(
    "stops when ownership aborts during %s",
    async (boundary) => {
      const f = conflictFixture();
      const controller = new AbortController();
      const error = new Error("synthetic ownership abort");
      f.meeting.ownershipSignal = controller.signal;
      const getOwned = f.read.getMockImplementation();
      if (!getOwned) throw new Error("Expected real repository read");
      f.read.mockImplementation(async (...args) => {
        const row = await getOwned(...args);
        if (
          boundary === "read" ||
          (boundary === "reread" && f.read.mock.calls.length === 2)
        )
          controller.abort(error);
        return row;
      });
      f.writes.mockImplementationOnce(async (input) => {
        f.edit(1);
        const result = await f.transition(input);
        if (boundary === "transition") controller.abort(error);
        return result;
      });
      await expect(
        saveOwnedMeetingHistoryService(f.meeting, f.terminal),
      ).rejects.toBe(error);
      expect(f.writes).toHaveBeenCalledTimes(boundary === "read" ? 0 : 1);
      expect(f.current().status).toBe("processing");
    },
  );

  it("stops when finalization aborts during a canonical retry read", async () => {
    const f = conflictFixture();
    const controller = new AbortController();
    const error = new Error("synthetic finalization abort");
    f.meeting.finalization = {
      controller,
      promise: Promise.resolve(),
      disposition: "pending",
    };
    const getOwned = f.read.getMockImplementation();
    if (!getOwned) throw new Error("Expected real repository read");
    f.read.mockImplementation(async (...args) => {
      const row = await getOwned(...args);
      if (f.read.mock.calls.length === 2) controller.abort(error);
      return row;
    });
    f.writes.mockImplementationOnce(async (input) => {
      f.edit(1);
      return f.transition(input);
    });
    await expect(
      saveOwnedMeetingHistoryService(f.meeting, f.terminal),
    ).rejects.toBe(error);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(f.current().status).toBe("processing");
  });

  it.each(["policy", "acknowledgment", "progress"] as const)(
    "does not retry a canonical edit with an independent delivery %s change",
    async (field) => {
      const f = conflictFixture();
      f.edit(1);
      f.writes.mockImplementationOnce(async (input) => {
        f.edit(2);
        const delivery = f.current().updateDelivery;
        if (!delivery) throw new Error("Expected canonical delivery intent");
        if (field === "policy") delivery.policy = { kind: "active" };
        if (field === "acknowledgment")
          delivery.parts.notesTitle.acknowledged = 1;
        if (field === "progress")
          delivery.progress = {
            kind: "blocked",
            reason: "provider_outcome_unknown",
          };
        return f.transition(input);
      });
      await expect(
        saveOwnedMeetingHistoryService(f.meeting, f.terminal),
      ).rejects.toThrow("fenced");
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(f.current().status).toBe("processing");
    },
  );

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
