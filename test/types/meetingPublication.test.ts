/** @jest-environment node */
import { history, pending, pointers } from "./meetingUpdateDelivery.fixture";
import { runningJob } from "../repositories/meetingRegenerationContract";
import type { MeetingHistory } from "../../src/types/db";
import type { DeliveryResult } from "../../src/types/meetingDelivery";
import { DELIVERY_DONE } from "../../src/services/meetingDelivery";
import {
  armRetryPublication,
  awaitsRetryPublication,
  publishesAfterRetry,
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
describe("publication after a processing retry", () => {
  const failed = (): MeetingHistory => ({
    ...history(),
    lifecycleVersion: 2,
    status: "failed",
    textChannelId: "999999999999999994",
  });
  const unpublished = () => ({
    ...pending(),
    policy: { kind: "unpublished" as const },
  });
  const retried = (): MeetingHistory => ({
    ...failed(),
    status: "complete",
    processingRetry: { ...runningJob, status: "succeeded", claim: undefined },
    updateDelivery: unpublished(),
  });
  const changes: [string, Partial<MeetingHistory>][] = [
    ["a legacy lifecycle row", { lifecycleVersion: undefined }],
    ["a personal meeting", { ownershipScope: "personal" }],
    ["no text channel", { textChannelId: undefined }],
    ["a summary message", { summaryMessageId: "summary" }],
    ["a notes channel", { notesChannelId: pointers.notesChannelId }],
    ["a delivery record", { delivery: {} }],
    ["a recovery value", { recovery: DELIVERY_DONE }],
    ["a finish marker", { finish: { attempts: 0, phase: "deliver" } }],
  ];
  it("hands back a failed, never-published meeting with regenerated notes", () => {
    expect(publishesAfterRetry(failed(), "Notes")).toBe(true);
    expect(
      publishesAfterRetry({ ...failed(), updateDelivery: unpublished() }, "N"),
    ).toBe(true);
  });
  const summaryOnlyFailure: Partial<MeetingHistory> = {
    status: "complete",
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "failed",
    },
  };
  it.each([
    ...changes,
    ["another status", { status: "complete" }],
    [
      "a completed meeting whose only failure was its summary",
      summaryOnlyFailure,
    ],
    [
      "a published meeting whose only failure was its summary",
      { ...summaryOnlyFailure, summaryMessageId: "summary" },
    ],
  ] as [string, Partial<MeetingHistory>][])(
    "does not hand back %s",
    (_, patch) => {
      expect(publishesAfterRetry({ ...failed(), ...patch }, "Notes")).toBe(
        false,
      );
    },
  );
  it.each([undefined, "", "  "])("does not hand back notes %p", (notes) => {
    expect(publishesAfterRetry(failed(), notes)).toBe(false);
  });
  it("finds a meeting retried before retries published", () => {
    expect(awaitsRetryPublication(retried())).toBe(true);
  });
  it.each([
    ...changes,
    ["a failed status", { status: "failed" }],
    ["no succeeded retry", { processingRetry: runningJob }],
    ["an active policy", { updateDelivery: pending() }],
    ["no notes", { notes: " " }],
  ] as [string, Partial<MeetingHistory>][])(
    "does not find a retried meeting with %s",
    (_, patch) => {
      expect(awaitsRetryPublication({ ...retried(), ...patch })).toBe(false);
    },
  );
  it("arms delivery with a held policy, replacing a stored one", () => {
    expect(armRetryPublication(failed(), unpublished())).toMatchObject({
      finish: { attempts: 0, phase: "deliver" },
      updateDelivery: {
        revision: "delivery-1",
        policy: { kind: "held", reason: "initial_publication_unsettled" },
      },
    });
  });
});
