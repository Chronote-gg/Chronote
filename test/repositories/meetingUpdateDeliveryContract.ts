import { planningContract } from "./meetingUpdatePlanningContract";
import { deliveryRow, paginationPlan } from "./meetingUpdateDeliveryFixtures";
import type { MeetingHistory } from "../../src/types/db";
import type {
  MeetingContentWrite,
  MeetingUpdateDeliveryRepository,
} from "../../src/repositories/meetingUpdateDeliveryRepository";
import {
  meetingUpdateDeliverySchema,
  preparedMeetingUpdateAttemptSchema,
  requestMeetingUpdateDelivery,
} from "../../src/types/meetingUpdateDelivery";
import {
  history,
  key,
  now,
  notes,
  pointers,
  attempt,
  running,
  pending,
  planDelivery,
  registerOperation,
} from "../types/meetingUpdateDelivery.fixture";
import { context } from "../deployment/controlFixtures";

export const authority = {
  kind: "serving",
  context: { ...context, now },
} as const;
export function write(
  row: MeetingHistory = history(),
  id = "save-1",
): MeetingContentWrite {
  return {
    key,
    expectedContentRevision: row.contentRevision ?? 0,
    expectedDeliveryRevision: row.updateDelivery?.revision ?? null,
    mutation: notes,
    nextDelivery: requestMeetingUpdateDelivery({
      history: row,
      mutation: notes,
      revision: id + "-delivery",
      now,
      policy: { kind: "active" },
    }),
    notesEdit: {
      expectedNotesVersion: row.notesVersion ?? 1,
      editedBy: "synthetic-editor",
      source: { type: "web_editor" },
    },
    mutationId: id,
    at: now,
  };
}

export function numericHeavyWrite(kind: "N" | "NS"): MeetingContentWrite {
  const input = write();
  input.mutation = {
    kind: "notes",
    notes: "n".repeat(50000),
    notesDelta: Array(150000).fill(kind === "N" ? 1 : new Set([1])),
  };
  return input;
}

export interface Harness {
  repository: MeetingUpdateDeliveryRepository;
  seed(row: MeetingHistory): Promise<void>;
  read(): Promise<MeetingHistory | undefined>;
  admit(allowed: boolean): Promise<void>;
}
export function deliveryContract(make: () => Harness) {
  let h: Harness;
  planningContract(() => h, { authority, write });
  const claimCurrent = (delivery: ReturnType<typeof pending>) =>
    h.repository.claim({
      key,
      expectedContentRevision: 1,
      expectedDeliveryRevision: delivery.revision,
      attempt: attempt(),
      authority,
    });
  beforeEach(async () => {
    h = make();
    await h.admit(true);
    await h.seed(history());
  });
  it("saves legacy notes, audit and intent together without changing unrelated content", async () => {
    const prior = {
      ...history(),
      notesDelta: { ops: [{ insert: "Original" }] },
      summarySentence: "Keep summary",
      meetingName: "Keep name",
    };
    await h.seed(prior);
    const input = write(prior);
    input.mutation = {
      ...notes,
      kind: "notes",
      notes: "Edited",
      notesDelta: null,
    };
    input.nextDelivery = requestMeetingUpdateDelivery({
      history: prior,
      mutation: input.mutation,
      revision: "save-1-delivery",
      now,
      policy: { kind: "active" },
    });
    expect(await h.repository.updateContentAndDelivery(input)).toMatchObject({
      kind: "committed",
      history: { notes: "Edited", notesVersion: 2, contentRevision: 1 },
    });
    const saved = await h.read();
    expect(saved).toMatchObject({
      notes: "Edited",
      notesVersion: 2,
      contentRevision: 1,
      summarySentence: "Keep summary",
      meetingName: "Keep name",
      notesHistory: [
        {
          version: 2,
          notes: "Edited",
          editedBy: "synthetic-editor",
          source: { type: "web_editor" },
        },
      ],
    });
    expect(saved?.updateDelivery?.parts.notesBody).toEqual({
      desired: 1,
      acknowledged: 0,
    });
    expect(saved?.updateDelivery?.parts.summaryBody).toEqual({
      desired: 0,
      acknowledged: 0,
    });
    expect(saved?.notesDelta).toBeUndefined();
    expect(saved?.updateDeliveryQueue).toBe("meeting-update:v1");
    expect(saved?.updateDeliveryDueAt).toBe(now);
  });
  it("rejects a missing row without upserting content or intent", async () => {
    const missing = { ...key, channelId_timestamp: "missing" };
    expect(
      await h.repository.updateContentAndDelivery({ ...write(), key: missing }),
    ).toEqual({ kind: "conflict" });
    expect(await h.repository.getStrong(missing)).toBeUndefined();
  });
  it("requires exact legacy content, notes version and envelope absence", async () => {
    for (const bad of [
      { expectedContentRevision: 1 },
      { expectedDeliveryRevision: "unexpected" },
      { notesEdit: { ...write().notesEdit!, expectedNotesVersion: 2 } },
    ])
      expect(
        await h.repository.updateContentAndDelivery({ ...write(), ...bad }),
      ).toEqual({ kind: "conflict" });
    expect(await h.read()).toEqual(history());
    expect((await h.repository.updateContentAndDelivery(write())).kind).toBe(
      "committed",
    );
    expect(
      await h.repository.updateContentAndDelivery(write(history(), "stale")),
    ).toEqual({ kind: "conflict" });
  });
  it("preserves correction fields and suggestion provenance while advancing notes once", async () => {
    const input = write();
    if (notes.kind !== "notes") throw new Error("Expected notes fixture");
    input.mutation = {
      kind: "correction",
      changes: [
        notes,
        { kind: "summarySentence", value: "Corrected summary" },
        { kind: "summaryLabel", value: "Corrected label" },
        { kind: "rename", meetingName: "Corrected name" },
      ],
    };
    input.nextDelivery = requestMeetingUpdateDelivery({
      history: history(),
      mutation: input.mutation,
      revision: "correction",
      now,
      policy: { kind: "active" },
    });
    const suggestion = {
      userId: "synthetic-editor",
      createdAt: "2026-10-22T12:00:00.000Z",
      text: "Synthetic correction",
    };
    input.notesEdit = { ...input.notesEdit!, suggestion };
    await h.repository.updateContentAndDelivery(input);
    expect(await h.read()).toMatchObject({
      summarySentence: "Corrected summary",
      summaryLabel: "Corrected label",
      meetingName: "Corrected name",
      suggestionsHistory: [suggestion],
      notesVersion: 2,
    });
  });
  it("keeps notes version and audit unchanged for rename", async () => {
    const input = write();
    input.mutation = { kind: "rename", meetingName: "Renamed" };
    input.notesEdit = undefined;
    input.nextDelivery = requestMeetingUpdateDelivery({
      history: history(),
      mutation: input.mutation,
      revision: "rename",
      now,
      policy: { kind: "active" },
    });
    await h.repository.updateContentAndDelivery(input);
    expect(await h.read()).toMatchObject({
      meetingName: "Renamed",
      contentRevision: 1,
    });
    expect((await h.read())?.notesVersion).toBeUndefined();
  });
  it("validates requested watermarks and retained metadata instead of accepting replacement intent", async () => {
    const input = write();
    input.nextDelivery = meetingUpdateDeliverySchema.parse({
      ...input.nextDelivery,
      parts: {
        ...input.nextDelivery.parts,
        summaryBody: { desired: 1, acknowledged: 0 },
      },
    });
    await expect(
      h.repository.updateContentAndDelivery(input),
    ).rejects.toThrow();
    expect(await h.read()).toEqual(history());
  });
  it("rejects a complete prospective item over the Dynamo item limit without partial changes", async () => {
    const prior = { ...history(), context: "x".repeat(350000) };
    await h.seed(prior);
    const input = write(prior);
    input.mutation = { kind: "notes", notes: "y".repeat(65000) };
    await expect(h.repository.updateContentAndDelivery(input)).rejects.toThrow(
      /size|limit/i,
    );
    expect(await h.read()).toEqual(prior);
  });
  it("requires exact work admission and claim identity", async () => {
    const row = deliveryRow(pending());
    await h.seed(row);
    await h.admit(false);
    expect(
      await h.repository.claim({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: "delivery-1",
        attempt: attempt(),
        authority,
      }),
    ).toBe("stale");
    await h.admit(true);
    expect(
      await h.repository.claim({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: "delivery-1",
        attempt: attempt(),
        authority,
      }),
    ).toBe("claimed");
    const saved = await h.read();
    expect(saved?.contentRevision).toBe(1);
    expect(saved?.updateDelivery?.progress).toMatchObject({
      kind: "running",
      attempt: attempt(),
      claim: { ownerInstanceId: "old" },
      operations: [
        { operationId: "patch-notes", submission: { kind: "prepared" } },
      ],
    });
    expect(
      await h.repository.claim({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: "delivery-1",
        attempt: attempt(),
        authority,
      }),
    ).toBe("stale");
  });
  it("rejects plans with stale pointers, captures or canonical revision", async () => {
    await h.seed(deliveryRow(pending()));
    for (const plan of [
      { ...attempt(), contentRevision: 2 },
      {
        ...attempt(),
        expectedPointers: { ...pointers, notesMessageIds: ["other"] },
      },
      { ...attempt(), capturedParts: { notesTitle: 1 } },
    ])
      expect(
        await h.repository.claim({
          key,
          expectedContentRevision: 1,
          expectedDeliveryRevision: "delivery-1",
          attempt: preparedMeetingUpdateAttemptSchema.parse(plan),
          authority,
        }),
      ).toBe("stale");
  });
  it("retains submitted evidence on expired-lease reconciliation", async () => {
    const delivery = running();
    await h.seed(deliveryRow(delivery));
    expect(await claimCurrent(delivery)).toBe("claimed");
    expect((await h.read())?.updateDelivery?.progress).toMatchObject({
      kind: "reconciling",
      operations:
        delivery.progress.kind === "running"
          ? delivery.progress.operations
          : [],
    });
  });
  it("fences stale owners and attempt acknowledgments", async () => {
    const delivery = running("verified");
    await h.seed(deliveryRow(delivery));
    for (const bad of [
      { ownerInstanceId: "other" },
      { attemptId: "other" },
      { expectedDeliveryRevision: "other" },
    ])
      expect(
        await h.repository.transition({
          key,
          expectedDeliveryRevision: delivery.revision,
          attemptId: "attempt-1",
          ownerInstanceId: "synthetic-owner",
          change: {
            kind: "complete",
            revision: "completion",
            attemptId: "attempt-1",
            completedAt: now,
          },
          ...bad,
        }),
      ).toBe("stale");
    expect((await h.read())?.updateDelivery).toEqual(delivery);
  });
  it.each(["save-first", "worker-first"])(
    "preserves newer desired work when %s wins",
    async (order) => {
      const row = {
        ...history(),
        ...pointers,
        contentRevision: 1,
        updateDelivery: running("verified"),
      };
      await h.seed(row);
      const save = write(row, "newer-save");
      const complete = (revision: string) =>
        h.repository.transition({
          key,
          expectedDeliveryRevision: revision,
          attemptId: "attempt-1",
          ownerInstanceId: "synthetic-owner",
          change: {
            kind: "complete",
            revision: "completion",
            attemptId: "attempt-1",
            completedAt: now,
          },
        });
      if (order === "save-first") {
        await h.repository.updateContentAndDelivery(save);
        expect(await complete(row.updateDelivery.revision)).toBe("stale");
        expect(await complete(save.nextDelivery.revision)).toBe("applied");
      } else {
        expect(await complete(row.updateDelivery.revision)).toBe("applied");
        expect(await h.repository.updateContentAndDelivery(save)).toEqual({
          kind: "conflict",
        });
        await h.repository.updateContentAndDelivery(
          write((await h.read())!, "replanned-save"),
        );
      }
      const saved = await h.read();
      expect(saved).toMatchObject({
        contentRevision: 2,
        updateDelivery: {
          parts: { notesBody: { desired: 2, acknowledged: 1 } },
          progress: { kind: "pending" },
          lastSuccess: { at: now, contentRevision: 1 },
        },
      });
    },
  );
  it("has one winner for simultaneous content writes", async () => {
    const results = await Promise.all([
      h.repository.updateContentAndDelivery(write(history(), "a")),
      h.repository.updateContentAndDelivery(write(history(), "b")),
    ]);
    expect(
      results.filter((result) => result.kind === "committed"),
    ).toHaveLength(1);
    expect((await h.read())?.contentRevision).toBe(1);
  });
  it("registers the complete exact pointer set under captured revision", async () => {
    const operation = registerOperation();
    const delivery = planDelivery(
      [operation],
      [{ kind: "submitted", submissionId: "register", submittedAt: now - 1 }],
    );
    const row = deliveryRow(delivery);
    await h.seed(row);
    const input = {
      key,
      expectedContentRevision: 1,
      expectedDeliveryRevision: delivery.revision,
      attemptId: "attempt-1",
      expectedPointers: pointers,
      nextPointers: pointers,
    };
    expect(
      await h.repository.registerNotesPointers({
        ...input,
        expectedPointers: { ...pointers, notesMessageIds: ["wrong"] },
      }),
    ).toBe("stale");
    expect(
      await h.repository.registerNotesPointers({
        ...input,
        expectedContentRevision: 2,
      }),
    ).toBe("stale");
    expect(
      await h.repository.registerNotesPointers({
        ...input,
        nextPointers: { ...pointers, notesMessageIds: ["unrecorded"] },
      }),
    ).toBe("stale");
    expect(await h.repository.registerNotesPointers(input)).toBe("applied");
    expect((await h.read())?.contentRevision).toBe(1);
  });
  it("suppresses due attributes while held and after verified completion", async () => {
    const row = {
      ...history(),
      contentRevision: 1,
      updateDelivery: running("verified"),
      updateDeliveryQueue: "meeting-update:v1" as const,
      updateDeliveryDueAt: now,
    };
    await h.seed(row);
    expect(
      await h.repository.transition({
        key,
        expectedDeliveryRevision: row.updateDelivery.revision,
        attemptId: "attempt-1",
        ownerInstanceId: "synthetic-owner",
        change: {
          kind: "complete",
          revision: "done",
          attemptId: "attempt-1",
          completedAt: now,
        },
      }),
    ).toBe("applied");
    expect((await h.read())?.updateDeliveryQueue).toBeUndefined();
    const input = write((await h.read())!, "held");
    input.nextDelivery = requestMeetingUpdateDelivery({
      history: { ...(await h.read())!, updateDelivery: undefined },
      mutation: notes,
      revision: "held-delivery",
      now,
      policy: { kind: "held", reason: "explicit_hold" },
    });
    // Policy changes require their own typed transition and cannot enter through a save.
    await expect(
      h.repository.updateContentAndDelivery(input),
    ).rejects.toThrow();
  });
  it("rejects malformed cursors and unbounded discovery", async () => {
    for (const cursor of [
      "!",
      Buffer.from(JSON.stringify({ guildId: "x" })).toString("base64url"),
    ])
      await expect(
        h.repository.listDue({ now, limit: 2, cursor }),
      ).rejects.toThrow();
    for (const limit of [0, 26, 1.5])
      await expect(h.repository.listDue({ now, limit })).rejects.toThrow();
  });

  it("does not let a transition bypass transactional claim admission", async () => {
    await h.seed(deliveryRow(pending()));
    const progress = planDelivery(attempt().operations, [
      { kind: "prepared" },
    ]).progress;
    await expect(
      h.repository.transition({
        key,
        expectedDeliveryRevision: "delivery-1",
        attemptId: null,
        ownerInstanceId: null,
        change: { kind: "progress", revision: "bypass", progress },
      }),
    ).rejects.toThrow(/claim|admission/i);
    expect((await h.read())?.updateDelivery?.progress.kind).toBe("pending");
  });
  it("does not let the current owner give its claim to a different runtime", async () => {
    const delivery = running();
    await h.seed(deliveryRow(delivery));
    if (delivery.progress.kind !== "running")
      throw new Error("Expected running fixture");
    await expect(
      h.repository.transition({
        key,
        expectedDeliveryRevision: delivery.revision,
        attemptId: "attempt-1",
        ownerInstanceId: "synthetic-owner",
        change: {
          kind: "progress",
          revision: "transfer",
          progress: {
            ...delivery.progress,
            kind: "reconciling",
            claim: { ...delivery.progress.claim, ownerInstanceId: "other" },
          },
        },
      }),
    ).rejects.toThrow(/claim|owner/i);
  });
  it("increments retry history only for a known failure", async () => {
    const delivery = planDelivery(attempt().operations, [
      {
        kind: "rejected",
        submissionId: "known",
        submittedAt: now - 2,
        rejectedAt: now - 1,
        retryAt: now + 100,
        reason: "rate_limited",
      },
    ]);
    await h.seed(deliveryRow(delivery));
    expect(
      await h.repository.transition({
        key,
        expectedDeliveryRevision: delivery.revision,
        attemptId: "attempt-1",
        ownerInstanceId: "synthetic-owner",
        change: {
          kind: "progress",
          revision: "retry",
          progress: {
            kind: "retrying",
            reason: "rate_limited",
            nextCheckAt: now + 100,
          },
        },
      }),
    ).toBe("applied");
    expect((await h.read())?.updateDelivery).toMatchObject({
      attempts: 1,
      progress: { kind: "retrying", nextCheckAt: now + 100 },
    });
  });
  it("keeps a created message candidate when newer content retires settled pagination", async () => {
    const delivery = paginationPlan("retire");
    const row = deliveryRow(delivery);
    await h.seed(row);
    const input = write(row, "supersede");
    await h.repository.updateContentAndDelivery(input);
    expect(
      await h.repository.transition({
        key,
        expectedDeliveryRevision: input.nextDelivery.revision,
        attemptId: "attempt-1",
        ownerInstanceId: "synthetic-owner",
        change: {
          kind: "progress",
          revision: "retire",
          progress: { kind: "pending", nextCheckAt: now },
        },
      }),
    ).toBe("applied");
    expect((await h.read())?.updateDelivery?.createdCandidates).toContainEqual({
      operationId: "post",
      channelId: pointers.notesChannelId,
      messageId: "created-message",
      fingerprint: "b".repeat(64),
    });
  });

  it("recognizes an exact repeated mutation but rejects reuse with different canonical data", async () => {
    const input = write();
    expect((await h.repository.updateContentAndDelivery(input)).kind).toBe(
      "committed",
    );
    expect((await h.repository.updateContentAndDelivery(input)).kind).toBe(
      "committed",
    );
    expect(
      await h.repository.updateContentAndDelivery({
        ...input,
        mutation: { kind: "notes", notes: "Different" },
      }),
    ).toEqual({ kind: "conflict" });
    expect((await h.read())?.notesVersion).toBe(2);
  });
  it("distinguishes supported opaque Delta values in exact mutation recognition", async () => {
    const input = write();
    input.mutation = {
      kind: "notes",
      notes: "Edited",
      notesDelta: new Set(["a"]),
    };
    await h.repository.updateContentAndDelivery(input);
    expect(
      await h.repository.updateContentAndDelivery({
        ...input,
        mutation: { ...input.mutation, notesDelta: new Set(["b"]) },
      }),
    ).toEqual({ kind: "conflict" });
  });
  it("removes due keys on a hold and restores them only through a typed policy transition", async () => {
    await h.seed({
      ...history(),
      contentRevision: 1,
      updateDelivery: pending(),
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: now,
    });
    expect(
      await h.repository.transition({
        key,
        expectedDeliveryRevision: "delivery-1",
        attemptId: null,
        ownerInstanceId: null,
        change: {
          kind: "policy",
          revision: "held",
          policy: { kind: "held", reason: "explicit_hold" },
          nextCheckAt: now,
        },
      }),
    ).toBe("applied");
    expect((await h.read())?.updateDeliveryQueue).toBeUndefined();
    expect(
      await h.repository.transition({
        key,
        expectedDeliveryRevision: "held",
        attemptId: null,
        ownerInstanceId: null,
        change: {
          kind: "policy",
          revision: "active",
          policy: { kind: "active" },
          nextCheckAt: now + 10,
        },
      }),
    ).toBe("applied");
    expect(await h.read()).toMatchObject({
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: now + 10,
    });
  });
  it("persists pointer growth only for verified recorded POST receipts", async () => {
    const delivery = paginationPlan("grow");
    await h.seed(deliveryRow(delivery));
    const nextPointers = {
      ...pointers,
      notesMessageIds: [...pointers.notesMessageIds, "created-message"],
    };
    expect(
      await h.repository.registerNotesPointers({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: delivery.revision,
        attemptId: "attempt-1",
        expectedPointers: pointers,
        nextPointers,
      }),
    ).toBe("applied");
    expect(await h.read()).toMatchObject(nextPointers);
    expect(
      await h.repository.registerNotesPointers({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: delivery.revision,
        attemptId: "attempt-1",
        expectedPointers: pointers,
        nextPointers: pointers,
      }),
    ).toBe("stale");
  });

  it("binds session admission to the exact meeting instead of another active lease", async () => {
    await h.seed(deliveryRow(pending()));
    expect(
      await h.repository.claim({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: "delivery-1",
        attempt: attempt(),
        authority: {
          kind: "session",
          now,
          ownership: {
            guildId: "other-guild",
            meetingId: "other-meeting",
            ownerInstanceId: "other-owner",
            executionVersion: 1,
            voiceOperationAttemptId: "other-attempt",
          },
        },
      }),
    ).toBe("stale");
  });

  it("serializes a simultaneous save and worker completion, then preserves the replanned loser", async () => {
    const row = deliveryRow(running("verified"));
    await h.seed(row);
    const input = write(row, "racing-save");
    const completion = {
      key,
      expectedDeliveryRevision: row.updateDelivery.revision,
      attemptId: "attempt-1",
      ownerInstanceId: "synthetic-owner",
      change: {
        kind: "complete" as const,
        revision: "racing-completion",
        attemptId: "attempt-1",
        completedAt: now,
      },
    };
    const [saved, completed] = await Promise.all([
      h.repository.updateContentAndDelivery(input),
      h.repository.transition(completion),
    ]);
    expect(
      Number(saved.kind === "committed") + Number(completed === "applied"),
    ).toBe(1);
    if (saved.kind === "conflict")
      await h.repository.updateContentAndDelivery(
        write((await h.read())!, "racing-replan"),
      );
    else
      expect(
        await h.repository.transition({
          ...completion,
          expectedDeliveryRevision: (await h.read())!.updateDelivery!.revision,
        }),
      ).toBe("applied");
    expect((await h.read())?.updateDelivery?.parts.notesBody).toEqual({
      desired: 2,
      acknowledged: 1,
    });
  });
  it("retains root retry and success metadata through claim persistence", async () => {
    const delivery = meetingUpdateDeliverySchema.parse({
      ...pending(),
      attempts: 3,
      lastSuccess: { at: now - 10, contentRevision: 1 },
    });
    await h.seed(deliveryRow(delivery));
    expect(await claimCurrent(delivery)).toBe("claimed");
    expect((await h.read())?.updateDelivery).toMatchObject({
      attempts: 3,
      lastSuccess: { at: now - 10, contentRevision: 1 },
    });
  });

  it("paginates only sparse due rows using complete opaque index cursors", async () => {
    for (let index = 0; index < 3; index++)
      await h.seed({
        ...deliveryRow(pending()),
        channelId_timestamp: "contract-due-" + index,
        updateDeliveryQueue: "meeting-update:v1",
        updateDeliveryDueAt: now - 10 + index,
      });
    await h.seed({
      ...deliveryRow(pending()),
      channelId_timestamp: "contract-future",
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: now + 100,
    });
    const first = await h.repository.listDue({ now: now - 1, limit: 2 });
    expect(first.keys).toHaveLength(2);
    expect(first.cursor).toEqual(expect.any(String));
    const second = await h.repository.listDue({
      now: now - 1,
      limit: 2,
      cursor: first.cursor,
    });
    expect(
      [...first.keys, ...second.keys]
        .map((row) => row.channelId_timestamp)
        .sort(),
    ).toEqual(["contract-due-0", "contract-due-1", "contract-due-2"]);
  });

  it.each(["N", "NS"] as const)(
    "rejects numeric-heavy %s items before persistence",
    async (kind) => {
      await expect(
        h.repository.updateContentAndDelivery(numericHeavyWrite(kind)),
      ).rejects.toThrow("Meeting item size exceeds DynamoDB limit");
      expect(await h.read()).toEqual(history());
    },
  );
}
