/** @jest-environment node */
import {
  requestMeetingUpdateDelivery,
  preparedMeetingUpdateAttemptSchema,
  meetingUpdateDeliverySchema,
  assertMeetingUpdateDeliveryTransition,
} from "../../src/types/meetingUpdateDelivery";
import { applyDeliveryChange } from "../../src/repositories/meetingUpdateDeliveryState";
import {
  history,
  pending,
  pointers,
  now,
  attempt,
  observedAttemptInput,
  planDelivery,
  registerOperation,
  verifiedState,
  deleteOperation,
  rejectedState,
  running,
} from "./meetingUpdateDelivery.fixture";

describe("meeting update planning contracts", () => {
  it.each([undefined, "", "   "])(
    "requests the effective fallback summary title for unnamed rows (%s)",
    (meetingName) => {
      const result = requestMeetingUpdateDelivery({
        history: { ...history(), meetingName, summaryLabel: "Old label" },
        mutation: {
          kind: "correction",
          changes: [{ kind: "summaryLabel", value: "New label" }],
        },
        revision: "next",
        now,
        policy: { kind: "active" },
      });
      expect(result.parts.summaryTitle).toEqual({
        desired: 1,
        acknowledged: 0,
      });
      expect(result.parts.summaryBody.desired).toBe(1);
      expect(result.parts.notesTitle.desired).toBe(0);
    },
  );

  it("preserves unaffected named and equivalent fallback titles", () => {
    for (const row of [
      { ...history(), meetingName: "Named", summaryLabel: "Old label" },
      { ...history(), summaryLabel: " New label " },
    ]) {
      const result = requestMeetingUpdateDelivery({
        history: row,
        mutation: {
          kind: "correction",
          changes: [{ kind: "summaryLabel", value: "New label" }],
        },
        revision: "next",
        now,
        policy: { kind: "active" },
      });
      expect(result.parts.summaryTitle.desired).toBe(0);
    }
  });

  it("represents verified observations without a fake provider operation", () => {
    const parsed = preparedMeetingUpdateAttemptSchema.safeParse(
      observedAttemptInput(),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const before = meetingUpdateDeliverySchema.parse({
      ...pending(),
      progress: {
        kind: "running",
        attempt: parsed.data,
        claim: { ownerInstanceId: "owner", leaseExpiresAt: now + 10 },
        nextCheckAt: now,
        operations: [],
      },
    });
    const next = applyDeliveryChange(before, {
      kind: "complete",
      revision: "complete",
      attemptId: "attempt-1",
      completedAt: now,
    });
    expect(next.parts.notesBody.acknowledged).toBe(1);
    expect(next.progress.kind).toBe("synced");
    expect(next.lastSuccess).toEqual({ at: now, contentRevision: 1 });
    expect(
      preparedMeetingUpdateAttemptSchema.safeParse({
        ...attempt(),
        operations: [],
      }).success,
    ).toBe(false);
  });

  it("does not replace or settle an older unknown effect with matching observations", () => {
    const before = running();
    const next = {
      ...before,
      revision: "changed",
      progress: { kind: "pending", nextCheckAt: now },
    };
    expect(() =>
      assertMeetingUpdateDeliveryTransition(
        before,
        meetingUpdateDeliverySchema.parse(next),
      ),
    ).toThrow(/Unsettled/);
  });

  it.each(["prepared", "rejected"])(
    "retains a %s obsolete DELETE after verified shorter registration",
    (kind) => {
      const obsolete = { ...deleteOperation, messageId: "999999999999999994" };
      const register = {
        ...registerOperation(),
        expectedPointers: {
          ...pointers,
          notesMessageIds: [...pointers.notesMessageIds, obsolete.messageId],
        },
      };
      const before = planDelivery(
        [register, obsolete],
        [verifiedState(), kind === "prepared" ? { kind } : rejectedState],
      );
      const after = applyDeliveryChange(before, {
        kind: "progress",
        revision: "retired",
        progress: { kind: "pending", nextCheckAt: now },
      });
      expect(after).toHaveProperty("cleanupCandidates", [
        {
          sourceAttemptId: "attempt-1",
          operationId: obsolete.operationId,
          registrationOperationId: register.operationId,
          channelId: obsolete.channelId,
          messageId: obsolete.messageId,
          beforeFingerprint: obsolete.beforeFingerprint,
        },
      ]);
      const again = applyDeliveryChange(after, {
        kind: "policy",
        revision: "again",
        policy: { kind: "active" },
        nextCheckAt: now,
      });
      expect(again).toHaveProperty(
        "cleanupCandidates",
        after.cleanupCandidates,
      );
    },
  );
});

describe("obsolete cleanup invariants", () => {
  function shrink(registrationVerified = true) {
    const obsolete = { ...deleteOperation, messageId: "999999999999999994" };
    const register = {
      ...registerOperation(),
      expectedPointers: {
        ...pointers,
        notesMessageIds: [...pointers.notesMessageIds, obsolete.messageId],
      },
    };
    return planDelivery(
      [register, obsolete],
      [
        registrationVerified ? verifiedState() : { kind: "prepared" },
        { kind: "prepared" },
      ],
    );
  }
  const retire = (before: ReturnType<typeof pending>) =>
    applyDeliveryChange(before, {
      kind: "progress",
      revision: before.revision + "-retired",
      progress: { kind: "pending", nextCheckAt: now },
    });
  it("does not invent obsolete identities from an unverified registration", () => {
    const after = retire(shrink(false));
    expect(after.cleanupCandidates).toEqual([]);
    const invented = {
      ...after,
      revision: "injected",
      cleanupCandidates: [
        {
          sourceAttemptId: "unproved",
          registrationOperationId: "register",
          operationId: "delete",
          channelId: "1",
          messageId: "2",
          beforeFingerprint: "b".repeat(64),
        },
      ],
    };
    expect(() =>
      assertMeetingUpdateDeliveryTransition(after, invented),
    ).toThrow(/provenance/);
  });
  it("prevents dropping or changing exact retained identity and provenance", () => {
    const retained = retire(shrink());
    for (const candidates of [
      [],
      [{ ...retained.cleanupCandidates[0], sourceAttemptId: "other" }],
      [{ ...retained.cleanupCandidates[0], beforeFingerprint: "a".repeat(64) }],
    ]) {
      expect(() =>
        assertMeetingUpdateDeliveryTransition(retained, {
          ...retained,
          revision: "lost",
          cleanupCandidates: candidates,
        }),
      ).toThrow(/Obsolete target/);
    }
    const again = retire({
      ...retained,
      revision: "claimed-again",
      progress: shrink(false).progress,
    });
    expect(again.cleanupCandidates).toEqual(retained.cleanupCandidates);
  });
  it("requires the exact fingerprint for verified cleanup disposition", () => {
    const retained = retire(shrink());
    const candidate = retained.cleanupCandidates[0];
    const deletion = {
      ...deleteOperation,
      channelId: candidate.channelId,
      messageId: candidate.messageId,
      beforeFingerprint: candidate.beforeFingerprint,
    };
    for (const same of [true, false]) {
      const operation = {
        ...deletion,
        beforeFingerprint: same ? candidate.beforeFingerprint : "a".repeat(64),
      };
      const active = planDelivery(
        [operation],
        [{ ...verifiedState(), fingerprint: operation.beforeFingerprint }],
      );
      active.cleanupCandidates = retained.cleanupCandidates;
      const after = retire(active);
      expect(after.cleanupCandidates).toHaveLength(same ? 0 : 1);
    }
  });
  it("requires exact target observation and verified registration for adoption", () => {
    const retained = retire(shrink());
    const candidate = retained.cleanupCandidates[0];
    for (const verified of [true, false]) {
      const register = {
        ...registerOperation(),
        slots: [{ kind: "existing", messageId: candidate.messageId }],
      };
      const active = planDelivery(
        [register],
        [verified ? verifiedState() : { kind: "prepared" }],
      );
      if (!("attempt" in active.progress)) throw new Error("Expected attempt");
      active.progress.attempt.observations = [
        {
          channelId: candidate.channelId,
          messageId: candidate.messageId,
          fingerprint: candidate.beforeFingerprint,
          observedAt: now,
        },
      ];
      active.cleanupCandidates = retained.cleanupCandidates;
      expect(retire(active).cleanupCandidates).toHaveLength(verified ? 0 : 1);
    }
  });
  it("reserves cleanup capacity before registration and never truncates metadata", () => {
    const retained = retire(shrink());
    const full = Array.from({ length: 300 }, (_, index) => ({
      ...retained.cleanupCandidates[0],
      messageId: "retained-" + index,
    }));
    const waiting = meetingUpdateDeliverySchema.parse({
      ...pending(),
      cleanupCandidates: full,
    });
    expect(
      applyDeliveryChange(waiting, {
        kind: "policy",
        revision: "kept",
        policy: { kind: "active" },
        nextCheckAt: now,
      }).cleanupCandidates,
    ).toEqual(full);
    expect(
      meetingUpdateDeliverySchema.safeParse({
        ...shrink(false),
        cleanupCandidates: full,
      }).success,
    ).toBe(false);
    expect(
      meetingUpdateDeliverySchema.safeParse({
        ...waiting,
        cleanupCandidates: [...full, { ...full[0], messageId: "overflow" }],
      }).success,
    ).toBe(false);
  });
  it("cannot discard an unknown DELETE after registration", () => {
    const before = shrink();
    if (!("attempt" in before.progress)) throw new Error("Expected attempt");
    before.progress.operations[1].submission = {
      kind: "submitted",
      submissionId: "delete-submitted",
      submittedAt: now,
    };
    expect(() => retire(before)).toThrow(/Unsettled/);
  });
});

it("cannot declare synced while retained targets have no verified disposition", () => {
  const before = applyDeliveryChange(
    planDelivery(
      [
        {
          ...registerOperation(),
          expectedPointers: {
            ...pointers,
            notesMessageIds: [
              ...pointers.notesMessageIds,
              "999999999999999994",
            ],
          },
        },
        { ...deleteOperation, messageId: "999999999999999994" },
      ],
      [verifiedState(), { kind: "prepared" }],
    ),
    {
      kind: "progress",
      revision: "cleanup-retired",
      progress: { kind: "pending", nextCheckAt: now },
    },
  );
  const parts = structuredClone(before.parts);
  parts.notesBody.acknowledged = 1;
  expect(
    meetingUpdateDeliverySchema.safeParse({
      ...before,
      parts,
      progress: { kind: "synced", syncedAt: now },
    }).success,
  ).toBe(false);
});

it("retains independent pending body/title revisions after a fallback label correction", () => {
  const first = requestMeetingUpdateDelivery({
    history: { ...history(), summaryLabel: "Old" },
    mutation: {
      kind: "correction",
      changes: [{ kind: "summaryLabel", value: "New" }],
    },
    revision: "corrected",
    now,
    policy: { kind: "active" },
  });
  const second = requestMeetingUpdateDelivery({
    history: {
      ...history(),
      contentRevision: 1,
      summaryLabel: "New",
      updateDelivery: first,
    },
    mutation: { kind: "notes", notes: "Newest notes" },
    revision: "newest",
    now: now + 1,
    policy: { kind: "active" },
  });
  expect(second.parts.summaryTitle).toEqual({ desired: 1, acknowledged: 0 });
  expect(second.parts.summaryBody).toEqual({ desired: 1, acknowledged: 0 });
  expect(second.parts.notesBody).toEqual({ desired: 2, acknowledged: 0 });
});

describe("inconsistent planning envelope rejection", () => {
  it.each(["delete", "register-delete", "patch"])(
    "returns an unsuccessful parse for missing %s progress",
    (kind) => {
      const operations =
        kind === "delete"
          ? [deleteOperation]
          : kind === "register-delete"
            ? [registerOperation(), deleteOperation]
            : [attempt().operations[0]];
      const before = planDelivery(
        operations,
        operations.map(() => ({ kind: "prepared" })),
      );
      if (!("attempt" in before.progress)) throw new Error("Expected attempt");
      before.progress.operations = [];
      expect(meetingUpdateDeliverySchema.safeParse(before)).toMatchObject({
        success: false,
      });
    },
  );
  it("rejects extra or mismatched progress without throwing", () => {
    for (const operations of [
      [{ operationId: "different", submission: { kind: "prepared" } }],
      [
        { operationId: "patch-notes", submission: { kind: "prepared" } },
        { operationId: "extra", submission: { kind: "prepared" } },
      ],
    ]) {
      const before = planDelivery(
        [attempt().operations[0]],
        [{ kind: "prepared" }],
      );
      expect(
        meetingUpdateDeliverySchema.safeParse({
          ...before,
          progress: { ...before.progress, operations },
        }),
      ).toMatchObject({ success: false });
    }
  });
  it("rejects duplicate observations and malformed cleanup fingerprints without throwing", () => {
    const observed = observedAttemptInput();
    expect(
      preparedMeetingUpdateAttemptSchema.safeParse({
        ...observed,
        observations: [...observed.observations, ...observed.observations],
      }),
    ).toMatchObject({ success: false });
    const malformed = {
      sourceAttemptId: "prior",
      operationId: "delete",
      registrationOperationId: "register",
      channelId: "1",
      messageId: "2",
      beforeFingerprint: "invalid",
    };
    expect(
      meetingUpdateDeliverySchema.safeParse({
        ...pending(),
        cleanupCandidates: [malformed],
      }),
    ).toMatchObject({ success: false });
  });
});
