import { createMockMeetingHistoryTransitionRepository } from "../../src/repositories/meetingHistoryTransitions";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";

/** The in-memory history rows, leases and checkpoint objects a recording checkpoint is written to. */
export function inMemoryCheckpointStore(
  histories: Map<string, MeetingHistory[]>,
  leases: Map<string, ActiveMeetingLease>,
) {
  return {
    repository: createMockMeetingHistoryTransitionRepository(histories, leases),
    objects: new Map<string, Buffer>(),
  };
}
