import type { MeetingUpdateActionResult } from "../../src/services/meetingUpdateService";
import { history as syntheticHistory } from "../types/meetingUpdateDelivery.fixture";
export const savedUpdate = (): Extract<
  MeetingUpdateActionResult,
  { kind: "saved" }
> => ({
  kind: "saved",
  history: {
    ...syntheticHistory(),
    canonicalWriter: {
      kind: "personal" as const,
      uploadId: "private-canonical-upload",
      instanceId: "private-canonical-owner",
      attempt: 1,
      claimId: "private-canonical-claim",
    },
  },
  delivery: {
    status: "pending",
    reason: null,
    pollable: true,
    desiredRevision: 1,
    syncedRevision: null,
    lastSuccess: null,
  },
});

export function expectSavedUpdateAcknowledgment(result: unknown) {
  expect(result).not.toHaveProperty("history");
  expect(JSON.stringify(result)).not.toMatch(
    /canonicalWriter|private-canonical-(owner|claim|upload)/,
  );
  expect(result).toMatchObject({
    ok: true,
    kind: "saved",
    delivery: { status: "pending" },
  });
}
