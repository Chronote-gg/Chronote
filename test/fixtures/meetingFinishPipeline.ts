import type { MeetingFinishDeps } from "../../src/services/meetingFinish";
import { getProcessingRetryEligibility } from "../../src/services/processingRetryEligibility";
import { projectMeetingUpdateDelivery } from "../../src/services/meetingUpdateStatus";
import type { MeetingHistory } from "../../src/types/db";
import { initialMeetingUpdatePolicy } from "../../src/types/meetingPublication";

/** What storage reports for an object it accepted. */
export function storedObject(key: string, body: string | Uint8Array) {
  return {
    key,
    versionId: null,
    byteLength: Buffer.byteLength(body),
    checksumSha256: "0".repeat(64),
  };
}

/** An upload that always succeeds, recorded for assertions. */
export const acceptingUpload = () =>
  jest.fn(async (key: string, body: string | Uint8Array) =>
    storedObject(key, body),
  );

/** Follow-on steps that succeed and do nothing, recorded for assertions. */
export function stubFollowOns(): MeetingFinishDeps["followOns"] {
  return {
    exportToNotion: jest.fn(async () => undefined),
    writeUserIndex: jest.fn(async () => undefined),
    captureCompleted: jest.fn(),
    sendWeeklyLimitNotice: jest.fn(async () => undefined),
  };
}

/**
 * A finished row with no leftover recovery or finish state, nothing to retry,
 * and an update policy that never posts.
 */
export function expectSettledAndUnpublished(row: MeetingHistory) {
  expect(row.recovery).toBeUndefined();
  expect(row.finish).toBeUndefined();
  expect(row.publicationRepair).toBeUndefined();
  expect(getProcessingRetryEligibility(row)).toEqual({
    eligible: false,
    reason: "nothing_failed",
  });
  expect(initialMeetingUpdatePolicy(row)).toEqual({ kind: "unpublished" });
  expect(projectMeetingUpdateDelivery(row)).toMatchObject({
    status: "unpublished",
  });
}
