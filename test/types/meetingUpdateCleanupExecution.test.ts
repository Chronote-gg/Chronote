/** @jest-environment node */
import { pending } from "./meetingUpdateDelivery.fixture";
import { assertMeetingUpdateDeliveryTransition } from "../../src/types/meetingUpdateDelivery";
import { applyDeliveryChange } from "../../src/repositories/meetingUpdateDeliveryState";
import { meetingUpdateDeliveryTransitionSchema } from "../../src/types/meetingUpdateDelivery";
import {
  sequentialCleanupPlan,
  advanceCleanup,
} from "./meetingUpdateCleanup.fixture";
test("current-attempt verified DELETE disposes exact obsolete target with an empty root and preserves the remaining tail", () => {
  let row = sequentialCleanupPlan();
  for (const index of [1, 2]) {
    row = applyDeliveryChange(
      row,
      meetingUpdateDeliveryTransitionSchema.parse(
        advanceCleanup(row, index, false),
      ),
    );
    row = applyDeliveryChange(
      row,
      meetingUpdateDeliveryTransitionSchema.parse(
        advanceCleanup(row, index, true),
      ),
    );
    expect(row.cleanupCandidates).toEqual([]);
  }
  if (!("attempt" in row.progress)) throw new Error("Expected attempt");
  expect(
    row.progress.operations.every((op) => op.submission.kind === "verified"),
  ).toBe(true);
});
test("wrong cleanup fingerprint and merely submitted DELETE cannot dispose target evidence", () => {
  const row = sequentialCleanupPlan();
  const submitted = applyDeliveryChange(
    row,
    meetingUpdateDeliveryTransitionSchema.parse(advanceCleanup(row, 1, false)),
  );
  const wrong = advanceCleanup(submitted, 1, true);
  wrong.progress.operations[1].submission = {
    ...wrong.progress.operations[1].submission,
    fingerprint: "a".repeat(64),
  };
  expect(() =>
    applyDeliveryChange(
      submitted,
      meetingUpdateDeliveryTransitionSchema.parse(wrong),
    ),
  ).toThrow();
  expect(() =>
    applyDeliveryChange(submitted, {
      kind: "progress",
      revision: "lost",
      progress: { kind: "pending", nextCheckAt: 1 },
    }),
  ).toThrow(/Unsettled/);
});

test("known preclaim exhaustion advances exactly once and preserves pending parts", () => {
  const before = { ...pending(), attempts: 7 };
  const after = applyDeliveryChange(before, {
    kind: "progress",
    revision: "eighth",
    progress: { kind: "blocked", reason: "retry_exhausted" },
  });
  expect(after.attempts).toBe(8);
  expect(after.parts).toEqual(before.parts);
  expect(after.lastSuccess).toBeNull();
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, { ...after, attempts: 9 }),
  ).toThrow(/Retry history/);
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, {
      ...after,
      progress: { kind: "blocked", reason: "unsupported_layout" },
    }),
  ).toThrow(/Retry history/);
});
