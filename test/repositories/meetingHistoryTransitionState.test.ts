/** @jest-environment node */
import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { isDeepStrictEqual } from "node:util";
import { publicationHistoryAfterPatch } from "../../src/repositories/meetingHistoryTransitionState";
import { history } from "../deployment/controlFixtures";

const stored = (value: object) =>
  unmarshall(marshall(value, { removeUndefinedValues: true }));

test("optional summary absence matches an actual DynamoDB read", () => {
  const result = publicationHistoryAfterPatch(history, {
    summarySentence: "Recovered summary.",
    summaryLabel: undefined,
  });
  expect(Object.hasOwn(result, "summaryLabel")).toBe(false);
  expect(isDeepStrictEqual(result, stored(result))).toBe(true);
});

test("undefined patch fields skip an existing summary label", () => {
  const row = { ...history, summaryLabel: "Keep this label" };
  const result = publicationHistoryAfterPatch(row, { summaryLabel: undefined });
  expect(result).toEqual(stored(row));
  expect(result.summaryLabel).toBe(row.summaryLabel);
});

test("nested optional values use the same codec as persistence", () => {
  const patch = {
    operatorRecovery: { retained: "value", optional: undefined },
  };
  const result = publicationHistoryAfterPatch(history, patch);
  expect(result).toEqual(stored({ ...history, ...patch }));
  expect(isDeepStrictEqual(result, stored(result))).toBe(true);
});

test("explicit null and untouched fields survive canonicalization", () => {
  const patch = { operatorRecovery: { explicit: null } };
  const result = publicationHistoryAfterPatch(history, patch);
  expect(result).toEqual(stored({ ...history, ...patch }));
  expect(result.operatorRecovery).toEqual({ explicit: null });
  expect(result.meetingId).toBe(history.meetingId);
});

test("changed real fields still fail strict history equality", () => {
  const result = publicationHistoryAfterPatch(history, {
    notes: "Changed notes",
  });
  expect(isDeepStrictEqual(stored(history), result)).toBe(false);
  expect(result.notes).toBe("Changed notes");
});

test("canonicalization does not mutate the row or patch", () => {
  const row = { ...history, operatorRecovery: { absent: undefined } };
  const patch = { summaryLabel: undefined };
  publicationHistoryAfterPatch(row, patch);
  expect(row.operatorRecovery).toEqual({ absent: undefined });
  expect(Object.hasOwn(patch, "summaryLabel")).toBe(true);
});

test("undefined publication pointer cannot release the durable lifecycle hold", () => {
  const row: import("../../src/types/db").MeetingHistory = {
    ...history,
    status: "interrupted",
    summaryMessageId: "summary",
    notesChannelId: "text",
    notesMessageIds: ["notes"],
    delivery: {
      summary: { outcome: "complete", intended: 1, sent: 1, errors: [] },
      notes: { outcome: "complete", intended: 1, sent: 1, errors: [] },
    },
    recovery: {
      disposition: "done",
      outcome: "completed",
      executionVersion: 1,
      attempt: 1,
      stage: "export",
      retry: { maxAttempts: 4, nextAttemptAt: null },
    },
  };
  row.updateDelivery = requestMeetingUpdateDelivery({
    history: row,
    mutation: { kind: "rename", meetingName: "Edited meeting" },
    revision: "held-revision",
    now: 100,
    policy: { kind: "held", reason: "initial_publication_unsettled" },
  });
  const result = publicationHistoryAfterPatch(row, {
    recovery: row.recovery,
    summaryMessageId: undefined,
  });
  expect(result.updateDelivery).toEqual(row.updateDelivery);
  expect(result.summaryMessageId).toBe("summary");
  expect(result.updateDeliveryDueAt).toBeUndefined();
});
