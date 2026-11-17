import { jest } from "@jest/globals";
import type { getMockStore } from "../../src/repositories/mockStore";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";

export function createMockCanonicalUpdateService(
  store: ReturnType<typeof getMockStore>,
) {
  return createMeetingUpdateService({
    repository: createMockMeetingUpdateDeliveryRepository(
      store.meetingHistoryByGuild,
      store.personalMediaUploadsById,
    ),
    ready: async () => {},
    syncNotes: jest.fn(async () => {}),
  });
}
