/** @jest-environment node */
import { getMeetingFinishRepository } from "../../src/repositories/meetingFinishRepository";
import { createMockMeetingFinishRepository } from "../../src/repositories/meetingFinishRepository";
import { getMockStore } from "../../src/repositories/mockStore";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import { useMockModeStore } from "./mockModeStore.fixture";
import {
  historyRow,
  meetingFinishContract,
} from "./meetingFinishRepository.contract";

describe("mock meeting finish repository", () => {
  meetingFinishContract(async () => {
    const histories = new Map<string, MeetingHistory[]>();
    const leases = new Map<string, ActiveMeetingLease>();
    return {
      repository: createMockMeetingFinishRepository(histories, leases),
      async seedHistory(row) {
        const rows = histories.get(row.guildId) ?? [];
        rows.push(structuredClone(row));
        histories.set(row.guildId, rows);
      },
      async seedLease(lease) {
        leases.set(lease.guildId, structuredClone(lease));
      },
      async readHistory(key) {
        const row = histories
          .get(key.guildId)
          ?.find(
            (candidate) =>
              candidate.channelId_timestamp === key.channelId_timestamp,
          );
        return row && structuredClone(row);
      },
    };
  });
});

describe("mock-mode binding", () => {
  useMockModeStore();

  it("finishes rows held in the mock store", async () => {
    const row = historyRow("binding", {
      guildId: "synthetic-binding-guild",
      status: "processing",
    });
    getMockStore().meetingHistoryByGuild.set(row.guildId, [row]);
    const claim = await getMeetingFinishRepository().claim(
      row,
      "synthetic-worker",
      1,
    );
    expect(claim?.owner).toBe("synthetic-worker");
    expect(row.finish?.owner).toBe("synthetic-worker");
  });
});
