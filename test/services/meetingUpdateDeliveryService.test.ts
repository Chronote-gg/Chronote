/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import {
  getRuntimeWorkAdmissionCheckpoints,
  releaseAcknowledgedRuntimeWork,
} from "../../src/services/runtimeWorkAdmissionService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import {
  deliveryFixture,
  deferred,
  loseAcknowledgement,
  holdPatch,
  hasSubmission,
  afterTransition,
  failStrongReads,
} from "./meetingUpdateDelivery.fixture";

import {
  runDelivery as run,
  initializeDeliveryClock,
  settleDeliveryWorks,
} from "./meetingUpdateDelivery.harness";
beforeEach(initializeDeliveryClock);
afterEach(settleDeliveryWorks);
test("real planner delivery preserves message surfaces and acknowledges captured notes only", async () => {
  const f = deliveryFixture();
  const first = f.input.messages[0];
  first.content = "Unrelated";
  first.components = [{ type: 1, components: [] }];
  first.attachments = [{ id: "777" }];
  f.remote.set(first.id, structuredClone(first));
  const result = await run(f).promise;
  expect(result.kind).toBe("settled");
  const row = await f.read();
  expect(row.updateDelivery.parts.notesBody).toEqual({
    desired: 1,
    acknowledged: 1,
  });
  expect(row.updateDelivery.lastSuccess).toEqual({
    at: now,
    contentRevision: 1,
  });
  expect(f.remote.get(first.id)).toMatchObject({
    content: "Unrelated",
    components: first.components,
    attachments: first.attachments,
    embeds: [expect.objectContaining({ description: "Edited notes" })],
  });
  expect(f.requests[0].payload).toEqual({
    embeds: expect.any(Array),
    allowed_mentions: { parse: [] },
  });
  expect(f.remote.get(f.input.history.summaryMessageId)).toEqual(
    f.input.messages.at(-1),
  );
});
test.each(["marker", "complete"])(
  "lost %s acknowledgement resolves exact durable state without duplicate HTTP",
  async (boundary) => {
    const f = deliveryFixture();
    loseAcknowledgement(f.repository, "transition", (input) =>
      boundary === "complete"
        ? input.change.kind === "complete"
        : input.change.kind === "progress" &&
          "operations" in input.change.progress &&
          input.change.progress.operations.some(
            (op) => op.submission.kind === "submitted",
          ),
    );
    expect((await run(f).promise).kind).toBe("settled");
    expect(f.requests).toHaveLength(1);
    expect((await f.read()).updateDelivery.progress.kind).toBe("synced");
  },
);
test("definite rate limiting preserves timing and counts one known failed attempt", async () => {
  const f = deliveryFixture();
  f.intercept(async (method) =>
    method === "PATCH"
      ? Response.json(
          { retry_after: 123 },
          { status: 429, headers: { "Retry-After": "120" } },
        )
      : undefined,
  );
  expect((await run(f).promise).kind).toBe("retryable");
  expect((await f.read()).updateDelivery).toMatchObject({
    attempts: 1,
    progress: { kind: "retrying", nextCheckAt: now + 123 },
  });
});
test.each([500, 200])(
  "ambiguous %s PATCH never settles from matching GET or replays after expiry",
  async (status) => {
    const f = deliveryFixture();
    f.intercept(async (method) =>
      method === "PATCH"
        ? new Response(status === 200 ? "invalid json" : "", { status })
        : undefined,
    );
    expect((await run(f).promise).kind).toBe("uncertain");
    const before = await f.read();
    const plan = planMeetingUpdate(f.input);
    if (plan.kind !== "ready") throw new Error("Expected plan");
    f.remote.set(plan.targets[0].messageId, plan.targets[0].after);
    f.intercept(undefined);
    const readsBefore = f.calls.filter((call) => call.method === "GET").length;
    const reconciled = await run(f, true).promise;
    expect(reconciled.kind).toBe("uncertain");
    expect(
      f.calls.filter((call) => call.method === "GET").length,
    ).toBeGreaterThan(readsBefore);
    expect(reconciled.observations).toContainEqual({
      operationId: plan.attempt.operations[0].operationId,
      kind: "desired",
    });
    expect(f.requests).toHaveLength(0);
    expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(
      0,
    );
    expect(before.updateDelivery.attempts).toBe(0);
    expect(before.updateDelivery.progress.kind).toBe("uncertain");
  },
);
test("newer save after acknowledged PATCH preserves newer desired while completing captured work", async () => {
  const f = deliveryFixture();
  let saved = false;
  f.intercept(async (method) => {
    if (method === "PATCH" && !saved) {
      saved = true;
      await f.save();
    }
    return undefined;
  });
  expect((await run(f).promise).kind).toBe("settled");
  expect((await f.read()).updateDelivery).toMatchObject({
    parts: { notesBody: { desired: 2, acknowledged: 1 } },
    lastSuccess: { contentRevision: 1 },
    progress: { kind: "pending" },
  });
});
test("growth persists POST IDs before pointer registration, shrink registers before deletion", async () => {
  const f = deliveryFixture("Old", "new ".repeat(4000));
  expect((await run(f).promise).kind).toBe("settled");
  const grown = await f.read();
  expect(grown.notesMessageIds!.length).toBeGreaterThan(1);
  const original = f.repository.registerNotesPointers.bind(f.repository);
  jest
    .spyOn(f.repository, "registerNotesPointers")
    .mockImplementation(async (input) => {
      const result = await original(input);
      throw new Error("Lost pointer acknowledgement " + result);
    });
  await f.save("short");
  const shrinkResult = await run(f).promise;
  expect({
    result: shrinkResult,
    progress: (await f.read()).updateDelivery.progress,
  }).toMatchObject({ result: { kind: "settled" } });
  const shrunk = await f.read();
  expect(shrunk.notesMessageIds).toEqual([f.input.messages[0].id]);
  expect(shrunk.updateDelivery.cleanupCandidates).toEqual([]);
  expect(f.requests.filter((r) => r.method === "DELETE").length).toBe(
    grown.notesMessageIds!.length - 1,
  );
});
test("deadline and fence retain actual provider lifetime until the held response settles", async () => {
  const f = deliveryFixture();
  const { entered, tail } = holdPatch(f);
  const { work, promise } = run(f, false, 1);
  expect(
    await Promise.race([
      entered.promise.then(() => true),
      promise.then(() => false),
    ]),
  ).toBe(true);
  work.fence();
  work.acknowledgeTerminal();
  let settled = false;
  const drain = work.settle().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const checkpoint = getRuntimeWorkAdmissionCheckpoints().find(
    (item) => item.signal === work.signal,
  )!;
  expect(checkpoint.effects.length).toBeGreaterThan(0);
  expect(releaseAcknowledgedRuntimeWork(checkpoint.id)).toBe(false);
  expect(settled).toBe(false);
  tail.resolve(Response.json(f.input.messages[0]));
  await promise;
  await drain;
  expect(
    getRuntimeWorkAdmissionCheckpoints().some(
      (item) => item.id === checkpoint.id,
    ),
  ).toBe(false);
});

test("same live owner can retire a marked operation whose HTTP invocation was positively prevented", async () => {
  const f = deliveryFixture();
  const invocation = run(f);
  afterTransition(
    f.repository,
    (input) => hasSubmission(input, "submitted"),
    () => invocation.work.fence(),
  );
  const result = await invocation.promise;
  expect(result.kind).toBe("retryable");
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect((await f.read()).updateDelivery).toMatchObject({
    attempts: 1,
    progress: { kind: "retrying", reason: "not_submitted" },
  });
});
test("lost submitted-marker ACK with unavailable exact readback issues no HTTP and preserves unknown evidence", async () => {
  const f = deliveryFixture();
  afterTransition(
    f.repository,
    (input) => hasSubmission(input, "submitted"),
    () => {
      failStrongReads(f.repository);
      throw new Error("Unknown marker ACK");
    },
  );
  const result = await run(f).promise;
  expect(result.kind).toBe("uncertain");
  expect(result.durable).toBeUndefined();
  expect(result.noClaim).toBeUndefined();
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
});
test("a submitted operation abandoned by a prior process cannot become not_submitted after reclaim", async () => {
  const f = deliveryFixture();
  const plan = planMeetingUpdate(f.input);
  if (plan.kind !== "ready") throw new Error("Expected plan");
  await f.repository.claim({
    key,
    expectedContentRevision: 1,
    expectedDeliveryRevision: f.input.history.updateDelivery.revision,
    attempt: plan.attempt,
    authority: f.authority,
  });
  const row = await f.read();
  const progress = row.updateDelivery.progress;
  if (!("attempt" in progress)) throw new Error("Expected claim");
  await f.repository.transition({
    key,
    expectedDeliveryRevision: row.updateDelivery.revision,
    attemptId: plan.attempt.attemptId,
    ownerInstanceId: "old",
    change: {
      kind: "progress",
      revision: "abandoned",
      progress: {
        ...progress,
        operations: progress.operations.map((op, index) =>
          index
            ? op
            : {
                ...op,
                submission: {
                  kind: "submitted",
                  submissionId: "abandoned-http",
                  submittedAt: now,
                },
              },
        ),
      },
    },
  });
  jest.spyOn(Date, "now").mockReturnValue((now + 61) * 1000);
  expect((await run(f, true).promise).kind).toBe("uncertain");
  const after = await f.read();
  expect(after.updateDelivery.attempts).toBe(0);
  expect(after.updateDelivery.parts.notesBody.acknowledged).toBe(0);
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
});
test("POST crash before durable returned ID remains held without duplicate creation", async () => {
  const f = deliveryFixture("old", "new ".repeat(4000));
  const original = f.repository.transition.bind(f.repository);
  jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
    if (
      input.change.kind === "progress" &&
      "operations" in input.change.progress &&
      input.change.progress.operations.some(
        (op) => op.submission.kind === "returned",
      )
    )
      throw new Error("Crash before ID write");
    return original(input);
  });
  expect((await run(f).promise).kind).toBe("uncertain");
  const before = f.calls.filter((call) => call.method === "POST").length;
  expect(before).toBe(1);
  jest.spyOn(Date, "now").mockReturnValue((now + 61) * 1000);
  expect((await run(f, true).promise).kind).toBe("uncertain");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(before);
  expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(0);
});
test("fresh no-op observations complete without invented provider submissions", async () => {
  const f = deliveryFixture("Edited notes", "Edited notes");
  const planned = planMeetingUpdate(f.input);
  if (planned.kind !== "ready") throw new Error("Expected plan");
  for (const target of planned.targets)
    f.remote.set(target.messageId, target.after);
  expect((await run(f).promise).kind).toBe("settled");
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect((await f.read()).updateDelivery.lastSuccess?.contentRevision).toBe(1);
});
test("eight known failures exhaust once and retain desired content", async () => {
  const f = deliveryFixture();
  const row = await f.read();
  row.updateDelivery.attempts = 7;
  f.setRow(row);
  f.intercept(async (method) =>
    method === "PATCH"
      ? Response.json({ retry_after: 300 }, { status: 429 })
      : undefined,
  );
  expect((await run(f).promise).kind).toBe("blocked");
  const after = await f.read();
  expect(after.updateDelivery).toMatchObject({
    attempts: 8,
    progress: { kind: "blocked", reason: "retry_exhausted" },
    parts: { notesBody: { desired: 1, acknowledged: 0 } },
  });
  const calls = f.calls.length;
  expect((await run(f).promise).kind).toBe("blocked");
  expect(f.calls.length).toBe(calls);
  expect((await f.read()).updateDelivery.attempts).toBe(8);
});
test("read-only preflight failure positively reports never-admitted local proof", async () => {
  const f = deliveryFixture();
  jest
    .spyOn(f.repository, "getStrong")
    .mockRejectedValue(new Error("Read unavailable"));
  const result = await run(f).promise;
  expect(result).toMatchObject({ noClaim: { kind: "never_admitted" } });
  expect(result.durable).toBeUndefined();
  expect(f.calls).toEqual([]);
});
test("renewal serializes with provider progress, retains newer desired and refreshes exact runtime checkpoint", async () => {
  const f = deliveryFixture();
  const entered = deferred<void>();
  const tail = deferred<Response>();
  const renewed = deferred<void>();
  f.intercept(async (method) => {
    if (method === "PATCH") {
      entered.resolve();
      return tail.promise;
    }
    return undefined;
  });
  const original = f.repository.transition.bind(f.repository);
  jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
    const result = await original(input);
    if (
      input.change.kind === "progress" &&
      "claim" in input.change.progress &&
      input.change.progress.claim.leaseExpiresAt > now + 60
    )
      renewed.resolve();
    return result;
  });
  const invocation = run(f, false, 10000, { renewalIntervalMs: 5 });
  await entered.promise;
  await f.save();
  jest.spyOn(Date, "now").mockReturnValue((now + 20) * 1000);
  await renewed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const expiresAt = getRuntimeWorkAdmissionCheckpoints().find(
    (item) => item.signal === invocation.work.signal,
  )?.claim?.expiresAt;
  const plan = planMeetingUpdate(f.input);
  if (plan.kind !== "ready") throw new Error("Expected plan");
  f.remote.set(plan.targets[0].messageId, plan.targets[0].after);
  tail.resolve(Response.json(plan.targets[0].after));
  const result = await invocation.promise;
  expect(result.kind).toBe("settled");
  expect(expiresAt).toBe(now + 80);
  expect(result.durable?.claim?.expiresAt).toBe(now + 80);
  expect((await f.read()).updateDelivery.parts.notesBody).toEqual({
    desired: 2,
    acknowledged: 1,
  });
});

test("lost completion ACK after a newer save proves captured success without clearing desired work", async () => {
  const f = deliveryFixture();
  const original = f.repository.transition.bind(f.repository);
  jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
    const result = await original(input);
    if (input.change.kind === "complete") {
      await f.save("newer after completion");
      throw new Error("Completion ACK lost");
    }
    return result;
  });
  const result = await run(f).promise;
  expect(result.kind).toBe("settled");
  expect(result.capturedRevision).toBe(1);
  expect((await f.read()).updateDelivery).toMatchObject({
    parts: { notesBody: { desired: 2, acknowledged: 1 } },
    lastSuccess: { contentRevision: 1 },
    progress: { kind: "pending" },
  });
});
test("save winning the pointer CAS retires settled work with known created IDs", async () => {
  const f = deliveryFixture("old", "growth ".repeat(3000));
  const original = f.repository.registerNotesPointers.bind(f.repository);
  jest
    .spyOn(f.repository, "registerNotesPointers")
    .mockImplementation(async (input) => {
      await f.save("newer");
      return original(input);
    });
  expect((await run(f).promise).kind).toBe("superseded");
  const row = await f.read();
  expect(row.updateDelivery.progress.kind).toBe("pending");
  expect(row.updateDelivery.createdCandidates.length).toBeGreaterThan(0);
  expect(row.updateDelivery.parts.notesBody.acknowledged).toBe(0);
});
test("pointer commit followed by a newer save and lost ACK verifies registration before retaining cleanup", async () => {
  const f = deliveryFixture("old ".repeat(4000), "short");
  const original = f.repository.registerNotesPointers.bind(f.repository);
  jest
    .spyOn(f.repository, "registerNotesPointers")
    .mockImplementation(async (input) => {
      await original(input);
      await f.save("newer");
      throw new Error("Pointer ACK lost");
    });
  expect((await run(f).promise).kind).toBe("superseded");
  const row = await f.read();
  expect(row.updateDelivery.progress.kind).toBe("pending");
  expect(row.updateDelivery.cleanupCandidates.length).toBeGreaterThan(0);
  expect(f.calls.filter((call) => call.method === "DELETE")).toEqual([]);
});
test("the eighth known preclaim failure is visible without fabricating a claim", async () => {
  const f = deliveryFixture();
  const row = await f.read();
  row.updateDelivery.attempts = 7;
  f.setRow(row);
  const discord = createDiscordMeetingUpdateTransport({
    token: "synthetic",
    fetchImpl: async () => {
      throw new Error("Preflight read failed");
    },
  });
  const result = await run(f, false, 10000, { discord }).promise;
  expect(result.kind).toBe("blocked");
  expect(result.durable?.claim).toBeNull();
  expect(result.capturedRevision).toBeNull();
  expect((await f.read()).updateDelivery).toMatchObject({
    attempts: 8,
    progress: { kind: "blocked", reason: "retry_exhausted" },
    parts: { notesBody: { desired: 1, acknowledged: 0 } },
  });
});

test("changed destination ownership before pagination POST prevents creation", async () => {
  const f = deliveryFixture("old", "growth ".repeat(3000));
  const original = f.repository.transition.bind(f.repository);
  jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
    const result = await original(input);
    if (
      input.change.kind === "progress" &&
      "operations" in input.change.progress &&
      input.change.progress.operations.some(
        (op) => op.submission.kind === "verified",
      )
    )
      f.input.channels[0].guild_id = "999999999999999900";
    return result;
  });
  const result = await run(f).promise;
  expect(result.kind).toBe("blocked");
  expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
  expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(0);
});
test("a summary pointer race after claim cannot rebind an immutable prepared plan", async () => {
  const f = deliveryFixture();
  const original = f.repository.claim.bind(f.repository);
  jest.spyOn(f.repository, "claim").mockImplementation(async (input) => {
    const result = await original(input);
    const row = await f.read();
    row.summaryMessageId = "555555555555555555";
    f.setRow(row);
    return result;
  });
  expect((await run(f).promise).kind).toBe("superseded");
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(0);
});
test("changed saved pointers after the final PATCH prevent captured completion", async () => {
  const f = deliveryFixture();
  f.intercept(async (method) => {
    if (method === "PATCH") {
      const row = await f.read();
      row.notesMessageIds = ["555555555555555555"];
      f.setRow(row);
    }
    return undefined;
  });
  expect((await run(f).promise).kind).toBe("superseded");
  expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(0);
});

test("fresh claim lost ACK cannot return never-admitted proof after invoking durable admission", async () => {
  const f = deliveryFixture();
  const original = f.repository.claim.bind(f.repository);
  jest.spyOn(f.repository, "claim").mockImplementation(async (input) => {
    await original(input);
    jest
      .spyOn(f.repository, "getStrong")
      .mockRejectedValue(new Error("Claim readback unavailable"));
    throw new Error("Claim ACK unknown");
  });
  const result = await run(f).promise;
  expect(result.kind).toBe("uncertain");
  expect(result.noClaim).toBeUndefined();
  expect(result.durable).toBeUndefined();
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("a definite preflight rate limit honors provider timing before any claim", async () => {
  const f = deliveryFixture();
  const calls: string[] = [];
  const discord = createDiscordMeetingUpdateTransport({
    token: "synthetic",
    fetchImpl: async (_url, init) => {
      calls.push(init?.method ?? "GET");
      return Response.json({ retry_after: 180 }, { status: 429 });
    },
  });
  const result = await run(f, false, 10000, { discord }).promise;
  expect(result.kind).toBe("retryable");
  expect(result.durable?.claim).toBeNull();
  expect((await f.read()).updateDelivery).toMatchObject({
    attempts: 1,
    progress: { kind: "retrying", nextCheckAt: now + 180 },
  });
  expect(calls).toEqual(["GET"]);
});
