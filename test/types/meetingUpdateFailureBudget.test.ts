/** @jest-environment node */
import { applyDeliveryChange } from "../../src/repositories/meetingUpdateDeliveryState";
import {
  assertMeetingUpdateDeliveryTransition,
  meetingUpdateDeliverySchema,
  preparedMeetingUpdateAttemptSchema,
} from "../../src/types/meetingUpdateDelivery";
import {
  planDelivery,
  patchOperation,
  postOperation,
  submittedState,
  observedAttemptInput,
} from "./meetingUpdateDelivery.fixture";
import { knownReadFailure } from "./meetingUpdateFailureBudget.fixture";
test.each([
  ["prepared", 0],
  ["prepared", 7],
  ["observed", 0],
  ["observed", 7],
  ["verified", 0],
  ["verified", 7],
] as const)(
  "known %s prerequisite failure counts prior%s once without inventing provider evidence",
  (kind, attempts) => {
    const before = knownReadFailure(kind, attempts);
    const progress =
      attempts === 7
        ? ({ kind: "blocked", reason: "retry_exhausted" } as const)
        : ({
            kind: "retrying",
            reason: "not_submitted",
            nextCheckAt:
              before.progress.kind === "running"
                ? before.progress.claim.leaseExpiresAt
                : 0,
          } as const);
    const after = applyDeliveryChange(before, {
      kind: "progress",
      revision: "known-failure",
      progress,
    });
    expect(after.attempts).toBe(attempts + 1);
    expect(after.progress).toEqual(progress);
    expect(after.parts).toEqual(before.parts);
    expect(after.createdCandidates).toEqual(before.createdCandidates);
    expect(after.cleanupCandidates).toEqual(before.cleanupCandidates);
    expect(after.lastSuccess).toEqual(before.lastSuccess);
  },
);
test("empty provider operations require actual observation evidence", () => {
  expect(
    preparedMeetingUpdateAttemptSchema.safeParse({
      ...observedAttemptInput(),
      observations: [],
    }).success,
  ).toBe(false);
});
test.each([
  [9, "retry_exhausted"],
  [8, "unsupported_layout"],
])(
  "prepared failure rejects invalid counter%s or reason%s",
  (attempts, reason) => {
    const before = knownReadFailure("prepared", 7);
    const after = meetingUpdateDeliverySchema.parse({
      ...before,
      revision: "invalid",
      attempts,
      progress: { kind: "blocked", reason },
    });
    expect(() => assertMeetingUpdateDeliveryTransition(before, after)).toThrow(
      /Retry history/,
    );
  },
);
test.each(["submitted", "uncertain", "returned"])(
  "a retained %s outcome cannot be exhausted as a known prerequisite failure",
  (kind) => {
    const operation =
      kind === "returned" ? postOperation : patchOperation("patch");
    const submission =
      kind === "returned"
        ? {
            ...submittedState,
            kind,
            messageId: "known-post",
            returnedAt: submittedState.submittedAt,
          }
        : kind === "uncertain"
          ? { ...submittedState, kind, reason: "provider_outcome_unknown" }
          : submittedState;
    const before = { ...planDelivery([operation], [submission]), attempts: 7 };
    expect(() =>
      applyDeliveryChange(before, {
        kind: "progress",
        revision: "not-known",
        progress: { kind: "blocked", reason: "retry_exhausted" },
      }),
    ).toThrow(/Unsettled|Retry history|identity/);
  },
);
