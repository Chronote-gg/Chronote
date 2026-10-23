import type { MeetingUpdateActionResult } from "../../src/services/meetingUpdateService";
import { history as syntheticHistory } from "../types/meetingUpdateDelivery.fixture";
export const savedUpdate = (): Extract<
  MeetingUpdateActionResult,
  { kind: "saved" }
> => ({
  kind: "saved",
  history: syntheticHistory(),
  delivery: {
    status: "pending",
    reason: null,
    pollable: true,
    desiredRevision: 1,
    syncedRevision: null,
    lastSuccess: null,
  },
});
