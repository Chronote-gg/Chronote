/** @jest-environment node */
import {
  assertMeetingUpdateDeliveryTransition,
  meetingUpdateDeliveryNextCheck,
  meetingUpdateDeliverySchema,
  meetingUpdateMutationSchema,
  preparedMeetingUpdateAttemptSchema,
  readMeetingUpdateDeliveryCursor,
  readMeetingUpdateRevisions,
  requestedPartsForMutation,
  requestMeetingUpdateDelivery,
  writeMeetingUpdateDeliveryCursor,
} from "../../src/types/meetingUpdateDelivery";

import {
  now,
  key,
  pointers,
  history,
  notes,
  rename,
  parts,
  pending,
  attempt,
  running,
  submittedState,
  rejectedState,
  verifiedState,
  patchOperation,
  postOperation,
  registerOperation,
  deleteOperation,
  planDelivery,
  changedProgress,
} from "./meetingUpdateDelivery.fixture";

test("notes edit preserves pending rename watermarks", () => {
  const before = requestMeetingUpdateDelivery({
    history: history(),
    mutation: rename,
    revision: "rename-request",
    now,
    policy: { kind: "active" },
  });
  const after = requestMeetingUpdateDelivery({
    history: {
      ...history(),
      contentRevision: 1,
      updateDelivery: before,
    },
    mutation: notes,
    revision: "notes-request",
    now: now + 1,
    policy: { kind: "active" },
  });
  expect(before.parts.notesTitle).toEqual({ desired: 1, acknowledged: 0 });
  expect(before.parts.summaryTitle).toEqual({ desired: 1, acknowledged: 0 });
  expect(after.parts.notesBody).toEqual({ desired: 2, acknowledged: 0 });
  expect(after.parts.notesTitle).toEqual(before.parts.notesTitle);
  expect(after.parts.summaryTitle).toEqual(before.parts.summaryTitle);
  expect(after.progress).toEqual(before.progress);
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, after),
  ).not.toThrow();
});

test("request retains submitted attempt", () => {
  const before = running();
  const after = requestMeetingUpdateDelivery({
    history: {
      ...history(),
      contentRevision: 1,
      updateDelivery: before,
    },
    mutation: notes,
    revision: "delivery-2",
    now,
    policy: { kind: "active" },
  });
  expect(after.parts.notesBody).toEqual({ desired: 2, acknowledged: 0 });
  expect(after.progress).toEqual(before.progress);
  expect(after.revision).toBe("delivery-2");
  expect(before.parts.notesBody.desired).toBe(1);
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, after),
  ).not.toThrow();
});

test("completion acknowledges only captured parts", () => {
  const before = meetingUpdateDeliverySchema.parse({
    ...running("verified"),
    parts: {
      ...parts(),
      notesBody: { desired: 2, acknowledged: 0 },
      summaryTitle: { desired: 2, acknowledged: 0 },
    },
  });
  const after = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "completion-2",
    lastSuccess: { at: now, contentRevision: 1 },
    parts: {
      ...before.parts,
      notesBody: { desired: 2, acknowledged: 1 },
    },
    progress: { kind: "pending", nextCheckAt: now },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, after),
  ).not.toThrow();
  expect(after.parts.notesBody).toEqual({ desired: 2, acknowledged: 1 });
  expect(after.parts.summaryTitle).toEqual(before.parts.summaryTitle);
  expect(meetingUpdateDeliveryNextCheck(after)).toBe(now);
  for (const part of ["notesBody", "summaryTitle"]) {
    const overAcknowledged = meetingUpdateDeliverySchema.parse({
      ...after,
      parts: {
        ...after.parts,
        [part]: { desired: 2, acknowledged: 2 },
      },
    });
    expect(() =>
      assertMeetingUpdateDeliveryTransition(before, overAcknowledged),
    ).toThrow();
  }
});

test("held state retains unsettled attempt", () => {
  const before = meetingUpdateDeliverySchema.parse({
    ...running(),
    policy: { kind: "held", reason: "stored_only" },
  });
  const after = requestMeetingUpdateDelivery({
    history: {
      ...history(),
      contentRevision: 1,
      updateDelivery: before,
    },
    mutation: notes,
    revision: "held-request-2",
    now,
    policy: { kind: "active" },
  });
  expect(after.policy).toEqual(before.policy);
  expect(after.progress).toEqual(before.progress);
  expect(after.parts.notesBody.desired).toBe(2);
  expect(meetingUpdateDeliveryNextCheck(after)).toBeUndefined();
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, after),
  ).not.toThrow();
  const discarded = meetingUpdateDeliverySchema.parse({
    ...after,
    revision: "discarded-attempt",
    progress: { kind: "pending", nextCheckAt: now },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(after, discarded),
  ).toThrow();
});

test("expired lease cannot authorize replay", () => {
  const before = running();
  expect(meetingUpdateDeliveryNextCheck(before)).toBe(now);
  if (before.progress.kind !== "running")
    throw new Error("Expected running fixture");
  const replay = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "replayed-2",
    progress: {
      ...before.progress,
      claim: {
        ownerInstanceId: "replacement-owner",
        leaseExpiresAt: now + 30,
      },
      operations: [
        { operationId: "patch-notes", submission: { kind: "prepared" } },
      ],
    },
  });
  expect(() => assertMeetingUpdateDeliveryTransition(before, replay)).toThrow();
  const replaced = meetingUpdateDeliverySchema.parse({
    ...replay,
    progress: {
      ...replay.progress,
      attempt: { ...attempt(), attemptId: "replacement-attempt" },
    },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, replaced),
  ).toThrow();
  const reconcile = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "reconcile-2",
    progress: { ...before.progress, kind: "reconciling" },
  });
  expect(reconcile.progress).toMatchObject({
    attempt: before.progress.attempt,
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, reconcile),
  ).not.toThrow();
});

test("legacy revisions remain zero and one", () => {
  const legacy = history();
  expect(readMeetingUpdateRevisions(legacy)).toEqual({
    contentRevision: 0,
    notesVersion: 1,
  });
  expect(
    readMeetingUpdateRevisions({
      ...legacy,
      contentRevision: 7,
      notesVersion: 4,
    }),
  ).toEqual({ contentRevision: 7, notesVersion: 4 });
  const requested = requestMeetingUpdateDelivery({
    history: legacy,
    mutation: notes,
    revision: "legacy-request",
    now,
    policy: { kind: "active" },
  });
  expect(requested.parts.notesBody).toEqual({ desired: 1, acknowledged: 0 });
  expect(legacy).not.toHaveProperty("contentRevision");
  expect(legacy).not.toHaveProperty("notesVersion");
});

test("notes requests do not include an unrelated summary", () => {
  expect(requestedPartsForMutation(notes)).toEqual(["notesBody"]);
  expect(requestedPartsForMutation(rename)).toEqual([
    "notesTitle",
    "summaryTitle",
  ]);
});

test("every transition needs an independent delivery revision", () => {
  const before = pending();
  const unchangedToken = meetingUpdateDeliverySchema.parse({
    ...before,
    parts: {
      ...before.parts,
      notesBody: { desired: 2, acknowledged: 0 },
    },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, unchangedToken),
  ).toThrow();
  const renewed = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "new-opaque-token",
    progress: { kind: "pending", nextCheckAt: now + 5 },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, renewed),
  ).not.toThrow();
});

test("submitted effects cannot be acknowledged before verification", () => {
  const before = running();
  const completed = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "premature-completion",
    parts: {
      ...before.parts,
      notesBody: { desired: 1, acknowledged: 1 },
    },
    progress: { kind: "synced", syncedAt: now },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, completed),
  ).toThrow();
});

test("rejects contradictory delivery state and duplicated payload bodies", () => {
  const invalid = [
    { ...pending(), attempt: attempt() },
    { ...pending(), notes: "Duplicated payload" },
    { ...pending(), progress: { kind: "synced", syncedAt: now } },
    {
      ...pending(),
      parts: {
        ...parts(),
        notesBody: { desired: 1, acknowledged: 2 },
      },
    },
    {
      ...pending(),
      progress: { kind: "pending", nextCheckAt: now, attempt: attempt() },
    },
  ];
  for (const value of invalid)
    expect(meetingUpdateDeliverySchema.safeParse(value).success).toBe(false);
  expect(
    preparedMeetingUpdateAttemptSchema.safeParse({
      ...attempt(),
      operations: [
        {
          ...attempt().operations[0],
          payload: { embeds: [{ description: "Duplicated provider body" }] },
        },
      ],
    }).success,
  ).toBe(false);
});

test.each(["unpublished", "held"] as const)(
  "%s policy has no due work",
  (kind) => {
    const delivery = meetingUpdateDeliverySchema.parse({
      ...pending(),
      policy: kind === "held" ? { kind, reason: "stored_only" } : { kind },
    });
    expect(meetingUpdateDeliveryNextCheck(delivery)).toBeUndefined();
  },
);

test("synced and blocked progress have no due work", () => {
  for (const progress of [
    { kind: "synced", syncedAt: now },
    { kind: "blocked", reason: "missing_target" },
  ]) {
    const delivery = meetingUpdateDeliverySchema.parse({
      ...pending(),
      parts: parts(),
      progress,
    });
    expect(meetingUpdateDeliveryNextCheck(delivery)).toBeUndefined();
  }
});

test("due cursor round trips exact keys and epoch seconds", () => {
  const cursor = {
    ...key,
    updateDeliveryQueue: "meeting-update:v1" as const,
    updateDeliveryDueAt: now,
  };
  expect(readMeetingUpdateDeliveryCursor()).toBeUndefined();
  expect(
    readMeetingUpdateDeliveryCursor(writeMeetingUpdateDeliveryCursor(cursor)),
  ).toEqual(cursor);
});

test("due cursor rejects malformed or widened discovery keys", () => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const value of [
    null,
    {},
    {
      ...key,
      updateDeliveryQueue: "wrong-queue",
      updateDeliveryDueAt: now,
    },
    {
      ...key,
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: -1,
    },
    {
      ...key,
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: now + 0.5,
    },
    {
      ...key,
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: now,
      extra: "unexpected",
    },
  ]) {
    expect(() => readMeetingUpdateDeliveryCursor(encode(value))).toThrow();
  }
  expect(() => readMeetingUpdateDeliveryCursor("not-json")).toThrow();
});

test("a save after sync schedules the new desired work", () => {
  const synced = meetingUpdateDeliverySchema.parse({
    ...pending(),
    parts: { ...parts(), notesBody: { desired: 1, acknowledged: 1 } },
    progress: { kind: "synced", syncedAt: now - 10 },
  });
  const after = requestMeetingUpdateDelivery({
    history: { ...history(), contentRevision: 1, updateDelivery: synced },
    mutation: notes,
    revision: "after-sync",
    now,
    policy: { kind: "active" },
  });
  expect(after.parts.notesBody).toEqual({ desired: 2, acknowledged: 1 });
  expect(after.progress).toEqual({ kind: "pending", nextCheckAt: now });
});

test("corrections request only their changed content and warning refresh is explicit", () => {
  const correction = meetingUpdateMutationSchema.parse({
    kind: "correction",
    changes: [
      { kind: "notes", notes: "Corrected synthetic notes" },
      { kind: "summarySentence", value: "Corrected synthetic summary" },
      { kind: "rename", meetingName: "Corrected synthetic name" },
    ],
  });
  expect(requestedPartsForMutation(correction)).toEqual([
    "notesBody",
    "notesTitle",
    "summaryBody",
    "summaryTitle",
  ]);
  const warning = meetingUpdateMutationSchema.parse({
    kind: "warning",
    target: "both",
  });
  expect(requestedPartsForMutation(warning)).toEqual([
    "notesWarning",
    "summaryWarning",
  ]);
  expect(
    meetingUpdateMutationSchema.safeParse({
      kind: "correction",
      changes: [
        { kind: "notes", notes: "A" },
        { kind: "notes", notes: "B" },
      ],
    }).success,
  ).toBe(false);
});

test("submission evidence cannot change identity during reconciliation", () => {
  const before = running();
  if (before.progress.kind !== "running")
    throw new Error("Expected running fixture");
  const after = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "altered-evidence",
    progress: {
      ...before.progress,
      kind: "reconciling",
      operations: [
        {
          operationId: "patch-notes",
          submission: {
            kind: "uncertain",
            submissionId: "another-submission",
            submittedAt: now - 30,
            reason: "provider_outcome_unknown",
          },
        },
      ],
    },
  });
  expect(() => assertMeetingUpdateDeliveryTransition(before, after)).toThrow();
});

test("cursor writer validates its input", () => {
  expect(() =>
    writeMeetingUpdateDeliveryCursor({
      ...key,
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: -1,
    }),
  ).toThrow();
});

test("retiring a verified POST retains its unregistered created message", () => {
  const postAttempt = preparedMeetingUpdateAttemptSchema.parse({
    ...attempt(),
    operations: [
      {
        kind: "post",
        operationId: "post-notes",
        channelId: pointers.notesChannelId,
        desiredFingerprint: "b".repeat(64),
      },
    ],
  });
  const before = meetingUpdateDeliverySchema.parse({
    ...pending(),
    progress: {
      kind: "running",
      attempt: postAttempt,
      claim: { ownerInstanceId: "synthetic-owner", leaseExpiresAt: now + 30 },
      nextCheckAt: now,
      operations: [
        {
          operationId: "post-notes",
          submission: {
            kind: "verified",
            submissionId: "post-submission",
            submittedAt: now - 30,
            verifiedAt: now - 2,
            fingerprint: "b".repeat(64),
            receipt: { kind: "message", messageId: "999999999999999994" },
          },
        },
      ],
    },
  });
  const discarded = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "retired-post",
    progress: { kind: "pending", nextCheckAt: now },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, discarded),
  ).toThrow();
  const retained = meetingUpdateDeliverySchema.parse({
    ...discarded,
    createdCandidates: [
      {
        operationId: "post-notes",
        channelId: pointers.notesChannelId,
        messageId: "999999999999999994",
        fingerprint: "b".repeat(64),
      },
    ],
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, retained),
  ).not.toThrow();
  const requested = requestMeetingUpdateDelivery({
    history: { ...history(), contentRevision: 1, updateDelivery: retained },
    mutation: notes,
    revision: "retained-next-save",
    now,
    policy: { kind: "active" },
  });
  expect(requested.createdCandidates).toEqual(retained.createdCandidates);
});

test("acknowledgment cannot regress even while a newer revision is requested", () => {
  const before = meetingUpdateDeliverySchema.parse({
    ...pending(),
    parts: { ...parts(), notesBody: { desired: 2, acknowledged: 1 } },
  });
  const after = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "regressed-ack",
    parts: { ...before.parts, notesBody: { desired: 3, acknowledged: 0 } },
  });
  expect(() => assertMeetingUpdateDeliveryTransition(before, after)).toThrow();
});

test("uncertain publication retains its attempt without scheduling replay", () => {
  const before = running();
  if (before.progress.kind !== "running")
    throw new Error("Expected running fixture");
  const { nextCheckAt, ...attemptState } = before.progress;
  void nextCheckAt;
  const uncertain = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "uncertainty-hold",
    progress: {
      ...attemptState,
      kind: "uncertain",
      reason: "provider_outcome_unknown",
    },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, uncertain),
  ).not.toThrow();
  expect(meetingUpdateDeliveryNextCheck(uncertain)).toBeUndefined();
  const requested = requestMeetingUpdateDelivery({
    history: { ...history(), contentRevision: 1, updateDelivery: uncertain },
    mutation: notes,
    revision: "saved-behind-uncertainty",
    now,
    policy: { kind: "active" },
  });
  expect(requested.progress).toEqual(uncertain.progress);
  expect(requested.parts.notesBody.desired).toBe(2);
  const replay = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "uncertain-replay",
    progress: { ...before.progress, nextCheckAt: now },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(uncertain, replay),
  ).toThrow();
});

test.each(["held", "unpublished"])(
  "%s blocks new submissions but retains reconciliation",
  (kind) => {
    const before = meetingUpdateDeliverySchema.parse({
      ...planDelivery([patchOperation("patch")], [{ kind: "prepared" }]),
      policy: kind === "held" ? { kind, reason: "stored_only" } : { kind },
    });
    const after = meetingUpdateDeliverySchema.parse({
      ...before,
      revision: "held-submit",
      progress: changedProgress(before, [submittedState]),
    });
    expect(() =>
      assertMeetingUpdateDeliveryTransition(before, after),
    ).toThrow();
    const submitted = meetingUpdateDeliverySchema.parse({
      ...before,
      progress: changedProgress(before, [submittedState]),
    });
    const reconciled = meetingUpdateDeliverySchema.parse({
      ...submitted,
      revision: "held-reconciled",
      progress: {
        ...changedProgress(submitted, [verifiedState()]),
        kind: "reconciling",
      },
    });
    expect(() =>
      assertMeetingUpdateDeliveryTransition(submitted, reconciled),
    ).not.toThrow();
  },
);

test.each([
  ["registration is prepared", "register", { kind: "prepared" }, false],
  ["registration is rejected", "register", rejectedState, false],
  ["earlier write is submitted", "patch", submittedState, false],
  [
    "earlier write is uncertain",
    "patch",
    {
      ...submittedState,
      kind: "uncertain",
      reason: "provider_outcome_unknown",
    },
    false,
  ],
  ["both writes are admitted", "patch", { kind: "prepared" }, true],
  ["predecessor settles in same transition", "register", submittedState, true],
])("ordered admission rejects %s", (_name, first, prior, advance) => {
  const operations =
    first === "register"
      ? [registerOperation(), deleteOperation]
      : [patchOperation("patch-a"), patchOperation("patch-b")];
  const before = planDelivery(operations, [prior, { kind: "prepared" }]);
  const nextFirst = advance
    ? first === "register"
      ? verifiedState()
      : submittedState
    : prior;
  expect(() => {
    const after = meetingUpdateDeliverySchema.parse({
      ...before,
      revision: "out-of-order",
      progress: changedProgress(before, [nextFirst, submittedState]),
    });
    assertMeetingUpdateDeliveryTransition(before, after);
  }).toThrow();
});

test("registration and cleanup advance one verified predecessor at a time", () => {
  let before = planDelivery(
    [registerOperation(), deleteOperation],
    [{ kind: "prepared" }, { kind: "prepared" }],
  );
  for (const [index, submissions] of [
    [submittedState, { kind: "prepared" }],
    [verifiedState(), { kind: "prepared" }],
    [verifiedState(), submittedState],
    [verifiedState(), verifiedState()],
  ].entries()) {
    const after = meetingUpdateDeliverySchema.parse({
      ...before,
      revision: "sequential-" + index,
      progress: changedProgress(before, submissions),
    });
    expect(() =>
      assertMeetingUpdateDeliveryTransition(before, after),
    ).not.toThrow();
    before = after;
  }
});

test("reused operation IDs cannot release an older candidate with another message ID", () => {
  const oldId = "999999999999999994";
  const newId = "999999999999999995";
  const origin = planDelivery([postOperation], [verifiedState(oldId)]);
  const oldCandidate = {
    operationId: "post-notes",
    channelId: pointers.notesChannelId,
    messageId: oldId,
    fingerprint: "b".repeat(64),
  };
  const retained = meetingUpdateDeliverySchema.parse({
    ...origin,
    revision: "retired-origin",
    createdCandidates: [oldCandidate],
    progress: { kind: "pending", nextCheckAt: now },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(origin, retained),
  ).not.toThrow();
  const newer = meetingUpdateDeliverySchema.parse({
    ...planDelivery(
      [postOperation, registerOperation(true)],
      [verifiedState(newId), verifiedState()],
    ),
    createdCandidates: retained.createdCandidates,
  });
  const cleared = meetingUpdateDeliverySchema.parse({
    ...newer,
    revision: "wrong-candidate-cleared",
    createdCandidates: [],
    progress: { kind: "pending", nextCheckAt: now },
  });
  expect(() => assertMeetingUpdateDeliveryTransition(newer, cleared)).toThrow();
  expect(() =>
    assertMeetingUpdateDeliveryTransition(
      newer,
      meetingUpdateDeliverySchema.parse({
        ...cleared,
        createdCandidates: [oldCandidate],
      }),
    ),
  ).not.toThrow();
});

test.each(["registration", "cleanup"])(
  "exact candidate %s permits retirement",
  (mode) => {
    const candidate = {
      operationId: "post-notes",
      channelId: pointers.notesChannelId,
      messageId: pointers.notesMessageIds[0],
      fingerprint: "b".repeat(64),
    };
    const before = meetingUpdateDeliverySchema.parse({
      ...planDelivery(
        mode === "registration"
          ? [postOperation, registerOperation(true)]
          : [deleteOperation],
        mode === "registration"
          ? [verifiedState(candidate.messageId), verifiedState()]
          : [verifiedState()],
      ),
      createdCandidates: [candidate],
    });
    const after = meetingUpdateDeliverySchema.parse({
      ...before,
      revision: "exact-candidate-retired",
      createdCandidates: [],
      progress: { kind: "pending", nextCheckAt: now },
    });
    expect(() =>
      assertMeetingUpdateDeliveryTransition(before, after),
    ).not.toThrow();
  },
);

test("retry count survives claim and reconciliation before the next failure", () => {
  const retrying = meetingUpdateDeliverySchema.parse({
    ...pending(),
    attempts: 5,
    progress: {
      kind: "retrying",
      nextCheckAt: now + 100,
      reason: "rate_limited",
    },
  });
  const claimed = meetingUpdateDeliverySchema.parse({
    ...retrying,
    revision: "retry-claimed",
    progress: planDelivery([patchOperation("patch")], [{ kind: "prepared" }])
      .progress,
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(retrying, claimed),
  ).not.toThrow();
  const executing = meetingUpdateDeliverySchema.parse({
    ...claimed,
    revision: "retry-submitted",
    progress: changedProgress(claimed, [submittedState]),
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(claimed, executing),
  ).not.toThrow();
  const { nextCheckAt, ...unsettled } = changedProgress(executing, [
    submittedState,
  ]);
  void nextCheckAt;
  const uncertain = meetingUpdateDeliverySchema.parse({
    ...executing,
    revision: "retry-uncertain",
    progress: {
      ...unsettled,
      kind: "uncertain",
      reason: "provider_outcome_unknown",
    },
  });
  expect(uncertain.attempts).toBe(5);
  expect(() =>
    assertMeetingUpdateDeliveryTransition(executing, uncertain),
  ).not.toThrow();
  const reconciling = meetingUpdateDeliverySchema.parse({
    ...uncertain,
    revision: "retry-reconcile",
    progress: {
      ...changedProgress(executing, [rejectedState]),
      kind: "reconciling",
    },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(uncertain, reconciling),
  ).not.toThrow();
  const retried = meetingUpdateDeliverySchema.parse({
    ...reconciling,
    revision: "retry-six",
    attempts: reconciling.attempts + 1,
    progress: {
      kind: "retrying",
      nextCheckAt: rejectedState.retryAt,
      reason: "rate_limited",
    },
  });
  expect(retried.attempts).toBe(6);
  expect(() =>
    assertMeetingUpdateDeliveryTransition(reconciling, retried),
  ).not.toThrow();
  expect(() =>
    assertMeetingUpdateDeliveryTransition(
      executing,
      meetingUpdateDeliverySchema.parse({
        ...reconciling,
        attempts: 0,
      }),
    ),
  ).toThrow();
  const superseded = requestMeetingUpdateDelivery({
    history: { ...history(), contentRevision: 1, updateDelivery: retried },
    mutation: notes,
    revision: "new-retry-sequence",
    now,
    policy: { kind: "active" },
  });
  expect(superseded.attempts).toBe(0);
  expect(meetingUpdateDeliveryNextCheck(superseded)).toBe(
    rejectedState.retryAt,
  );
});

test("verified completion records durable last success through a later save", () => {
  const before = meetingUpdateDeliverySchema.parse({
    ...planDelivery([patchOperation("patch")], [verifiedState()]),
    attempts: 5,
  });
  const completed = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: "known-success",
    attempts: 0,
    parts: { ...before.parts, notesBody: { desired: 1, acknowledged: 1 } },
    lastSuccess: { at: now + 2, contentRevision: 1 },
    progress: { kind: "synced", syncedAt: now + 2 },
  });
  expect(() =>
    assertMeetingUpdateDeliveryTransition(before, completed),
  ).not.toThrow();
  const pendingAgain = requestMeetingUpdateDelivery({
    history: { ...history(), contentRevision: 1, updateDelivery: completed },
    mutation: notes,
    revision: "new-save-after-success",
    now: now + 3,
    policy: { kind: "active" },
  });
  expect(pendingAgain.lastSuccess).toEqual(completed.lastSuccess);
  expect(pendingAgain.parts.notesBody).toEqual({ desired: 2, acknowledged: 1 });
  for (const lastSuccess of [
    null,
    { at: now + 99, contentRevision: 2 },
    { at: now, contentRevision: 1 },
  ]) {
    expect(() =>
      assertMeetingUpdateDeliveryTransition(
        pendingAgain,
        meetingUpdateDeliverySchema.parse({
          ...pendingAgain,
          revision: "forged-last-success",
          lastSuccess,
        }),
      ),
    ).toThrow();
  }
});

test("created registration slots require their POST before registration", () => {
  expect(
    preparedMeetingUpdateAttemptSchema.safeParse({
      ...attempt(),
      operations: [registerOperation(true), postOperation],
    }).success,
  ).toBe(false);
});
