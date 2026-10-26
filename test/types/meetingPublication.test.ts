/** @jest-environment node */
import { history, pointers } from "./meetingUpdateDelivery.fixture";
import type { MeetingHistory } from "../../src/types/db";
import type { DeliveryResult } from "../../src/types/meetingDelivery";
import {
  originalPublicationSettled,
  publicationSnapshot,
  initialMeetingUpdatePolicy,
} from "../../src/types/meetingPublication";
function settled(): MeetingHistory {
  return {
    ...history(),
    ...pointers,
    status: "complete",
    summaryMessageId: "summary",
    delivery: {
      summary: { outcome: "complete", intended: 1, sent: 1, errors: [] },
      notes: { outcome: "complete", intended: 1, sent: 1, errors: [] },
    },
  };
}
test.each([
  "complete",
  "edited_existing",
  "sent_fallback",
] satisfies DeliveryResult["outcome"][])(
  "accepts genuine summary outcome %s with exact notes proof",
  (outcome) => {
    const row = settled();
    row.delivery!.summary!.outcome = outcome;
    expect(originalPublicationSettled(publicationSnapshot(row))).toBe(true);
  },
);
test.each([
  "edited_existing",
  "sent_fallback",
  "partial",
  "failed",
  "not_applicable",
] satisfies DeliveryResult["outcome"][])(
  "rejects notes outcome %s",
  (outcome) => {
    const row = settled();
    row.delivery!.notes!.outcome = outcome;
    expect(originalPublicationSettled(publicationSnapshot(row))).toBe(false);
  },
);
test.each([
  "errors",
  "old-missing-error",
  "summary-count",
  "sent-count",
  "no-summary",
  "duplicate-notes",
  "no-channel",
  "unresolved-owner",
] as const)("holds ambiguous publication %s", (mode) => {
  const row = settled();
  if (mode === "errors") row.delivery!.summary!.errors = [{}];
  if (mode === "old-missing-error")
    row.delivery!.summary = {
      outcome: "sent_fallback",
      intended: 1,
      sent: 1,
      errors: [{ code: 10008, status: 404 }],
    };
  if (mode === "summary-count") row.delivery!.summary!.intended = 2;
  if (mode === "sent-count") row.delivery!.notes!.sent = 0;
  if (mode === "no-summary") row.summaryMessageId = undefined;
  if (mode === "duplicate-notes") {
    row.notesMessageIds = ["same", "same"];
    row.delivery!.notes!.intended = 2;
    row.delivery!.notes!.sent = 2;
  }
  if (mode === "no-channel") row.notesChannelId = undefined;
  if (mode === "unresolved-owner") row.ownerInstanceId = "owner";
  expect(originalPublicationSettled(publicationSnapshot(row))).toBe(false);
});
test.each(["processing", "complete"] as const)(
  "personal unpublished rows remain unpublished while %s",
  (status) => {
    expect(
      initialMeetingUpdatePolicy({
        ...history(),
        status,
        ownershipScope: "personal",
      }),
    ).toEqual({ kind: "unpublished" });
  },
);
