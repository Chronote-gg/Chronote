/** @jest-environment node */
import { getMeetingHistoryRepository } from "../../src/repositories/meetingHistoryRepository";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import type { MeetingHistory } from "../../src/types/db";
import { deliveryContract } from "./meetingUpdateDeliveryContract";
import { key } from "../types/meetingUpdateDelivery.fixture";

describe("mock meeting update persistence", () => {
  let histories: Map<string, MeetingHistory[]>;
  let allowed: boolean;
  beforeEach(() => {
    histories = new Map();
    allowed = true;
  });
  deliveryContract(() => ({
    repository: createMockMeetingUpdateDeliveryRepository(
      histories,
      () => allowed,
    ),
    async seed(row) {
      const rows = histories.get(row.guildId) ?? [];
      const index = rows.findIndex(
        (item) => item.channelId_timestamp === row.channelId_timestamp,
      );
      if (index < 0) rows.push(structuredClone(row));
      else rows[index] = structuredClone(row);
      histories.set(row.guildId, rows);
    },
    async read() {
      return structuredClone(
        histories
          .get(key.guildId)
          ?.find((row) => row.channelId_timestamp === key.channelId_timestamp),
      );
    },
    async admit(value) {
      allowed = value;
    },
  }));
});
it("exposes atomic persistence through the existing history repository", () => {
  expect(getMeetingHistoryRepository().getStrong).toEqual(expect.any(Function));
  expect(getMeetingHistoryRepository().updateContentAndDelivery).toEqual(
    expect.any(Function),
  );
});
