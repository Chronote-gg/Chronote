/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import {
  runDelivery as run,
  initializeDeliveryClock,
  settleDeliveryWorks,
} from "./meetingUpdateDelivery.harness";
import { deliveryFixture, deferred } from "./meetingUpdateDelivery.fixture";
import { now } from "../types/meetingUpdateDelivery.fixture";
beforeEach(initializeDeliveryClock);
afterEach(settleDeliveryWorks);
test("a newer save before registration retires settled POSTs and latest replan accounts for every returned ID", async () => {
  const f = deliveryFixture("Old", "growth ".repeat(3000));
  let saved = false;
  f.intercept(async (method) => {
    if (method === "POST" && !saved) {
      saved = true;
      await f.save("Latest short notes");
    }
    return undefined;
  });
  expect((await run(f).promise).kind).toBe("superseded");
  const retired = await f.read();
  expect(retired.updateDelivery.createdCandidates).toHaveLength(1);
  const createdId = retired.updateDelivery.createdCandidates[0].messageId;
  expect(retired.notesMessageIds).not.toContain(createdId);
  expect(f.remote.has(createdId)).toBe(true);
  f.intercept(undefined);
  expect((await run(f).promise).kind).toBe("settled");
  const after = await f.read();
  expect(after.updateDelivery.createdCandidates).toEqual([]);
  expect(after.updateDelivery.cleanupCandidates).toEqual([]);
  expect(after.updateDelivery.parts.notesBody).toEqual({
    desired: 2,
    acknowledged: 2,
  });
  expect(f.remote.has(createdId)).toBe(false);
});
test.each(["shorter", "growth"])(
  "shorter verified registration retains obsolete tails across newer %s work",
  async (next) => {
    const f = deliveryFixture("original ".repeat(3000), "short");
    const original = f.repository.transition.bind(f.repository);
    let saved = false;
    jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
      const result = await original(input);
      if (
        !saved &&
        input.change.kind === "progress" &&
        "attempt" in input.change.progress &&
        input.change.progress.attempt.operations.some(
          (op, i) =>
            op.kind === "register" &&
            input.change.kind === "progress" &&
            "operations" in input.change.progress &&
            input.change.progress.operations[i].submission.kind === "verified",
        )
      ) {
        saved = true;
        await f.save(next === "growth" ? "new ".repeat(4000) : "new short");
      }
      return result;
    });
    expect((await run(f).promise).kind).toBe("superseded");
    const before = await f.read();
    expect(before.notesMessageIds).toEqual([f.input.messages[0].id]);
    expect(before.updateDelivery.cleanupCandidates.length).toBeGreaterThan(0);
    const obsolete = before.updateDelivery.cleanupCandidates.map(
      (item) => item.messageId,
    );
    expect(f.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect((await run(f).promise).kind).toBe("settled");
    const after = await f.read();
    expect(after.updateDelivery.cleanupCandidates).toEqual([]);
    for (const id of obsolete) expect(f.remote.has(id)).toBe(false);
    expect(after.updateDelivery.lastSuccess?.contentRevision).toBe(2);
  },
);
test("definite DELETE rejection retains every obsolete target and its future timing", async () => {
  const f = deliveryFixture("original ".repeat(3000), "short");
  f.intercept(async (method) =>
    method === "DELETE"
      ? Response.json({ retry_after: 120 }, { status: 429 })
      : undefined,
  );
  expect((await run(f).promise).kind).toBe("retryable");
  const before = await f.read();
  expect(before.updateDelivery.cleanupCandidates.length).toBeGreaterThan(0);
  await f.save("newer");
  expect((await run(f).promise).kind).toBe("superseded");
  expect((await f.read()).updateDelivery.progress).toMatchObject({
    nextCheckAt: now + 120,
  });
  jest.spyOn(Date, "now").mockReturnValue((now + 120) * 1000);
  f.intercept(undefined);
  expect((await run(f).promise).kind).toBe("settled");
  expect((await f.read()).updateDelivery.cleanupCandidates).toEqual([]);
});
test("a delayed unsettled DELETE holds newer work and cannot settle from matching absence", async () => {
  const f = deliveryFixture("original ".repeat(3000), "short");
  const entered = deferred<void>();
  const tail = deferred<Response>();
  let deleting = "";
  f.intercept(async (method, id) => {
    if (method === "DELETE") {
      deleting = id;
      entered.resolve();
      return tail.promise;
    }
    return undefined;
  });
  const invocation = run(f);
  await entered.promise;
  await f.save("newer");
  const mutations = f.calls.filter((call) => call.method !== "GET").length;
  expect((await run(f).promise).kind).toBe("superseded");
  expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(
    mutations,
  );
  f.remote.delete(deleting);
  tail.reject(new Error("Uncertain DELETE connection"));
  expect((await invocation.promise).kind).toBe("uncertain");
  f.intercept(undefined);
  jest.spyOn(Date, "now").mockReturnValue((now + 100) * 1000);
  expect((await run(f, true).promise).kind).toBe("uncertain");
  expect((await f.read()).updateDelivery.parts.notesBody).toEqual({
    desired: 2,
    acknowledged: 0,
  });
  expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(
    mutations,
  );
});
test("protected whole surplus messages block before the first provider write", async () => {
  const f = deliveryFixture("original ".repeat(3000), "short");
  const surplus = f.input.messages[1];
  surplus.content = "Protected unrelated text";
  f.remote.set(surplus.id, surplus);
  expect((await run(f).promise).kind).toBe("blocked");
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(f.remote.get(surplus.id)?.content).toBe("Protected unrelated text");
});
test("recorded missing targets block without a replacement POST", async () => {
  const f = deliveryFixture();
  f.remote.delete(f.input.messages[0].id);
  expect((await run(f).promise).kind).toBe("blocked");
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect((await f.read()).updateDelivery.progress).toEqual({
    kind: "blocked",
    reason: "missing_target",
  });
});

test("durably returned POST identity is reclaimed read-only before a prepared tail is safely retired", async () => {
  const f = deliveryFixture("old", "growth ".repeat(3000));
  f.intercept(async (method, id) => {
    if (method === "GET" && id.startsWith("900"))
      throw new Error("Readback interrupted");
    return undefined;
  });
  expect((await run(f).promise).kind).toBe("uncertain");
  const before = await f.read();
  expect(before.updateDelivery.progress.kind).toBe("reconciling");
  const posts = f.calls.filter((call) => call.method === "POST").length;
  expect(posts).toBe(1);
  f.intercept(undefined);
  jest.spyOn(Date, "now").mockReturnValue((now + 61) * 1000);
  expect((await run(f, true).promise).kind).toBe("superseded");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
  expect((await f.read()).updateDelivery.createdCandidates).toHaveLength(1);
  expect((await run(f).promise).kind).toBe("settled");
  expect((await f.read()).updateDelivery.createdCandidates).toEqual([]);
});
test("repeated shorter registration supersession preserves outstanding obsolete IDs until final cleanup", async () => {
  const f = deliveryFixture("old ".repeat(5000), "short");
  const original = f.repository.transition.bind(f.repository);
  let saves = 0;
  jest.spyOn(f.repository, "transition").mockImplementation(async (input) => {
    const result = await original(input);
    if (
      saves < 2 &&
      input.change.kind === "progress" &&
      "attempt" in input.change.progress &&
      input.change.progress.attempt.operations.some(
        (op, index) =>
          op.kind === "register" &&
          input.change.kind === "progress" &&
          "operations" in input.change.progress &&
          input.change.progress.operations[index].submission.kind ===
            "verified",
      )
    ) {
      saves++;
      await f.save("latest " + saves);
    }
    return result;
  });
  const originalIds = [...f.input.history.notesMessageIds];
  for (let i = 0; i < 2; i++) {
    expect((await run(f).promise).kind).toBe("superseded");
    expect(
      (await f.read()).updateDelivery.cleanupCandidates.map(
        (candidate) => candidate.messageId,
      ),
    ).toEqual(originalIds.slice(1));
  }
  expect((await run(f).promise).kind).toBe("settled");
  for (const id of originalIds.slice(1)) expect(f.remote.has(id)).toBe(false);
  expect((await f.read()).updateDelivery.lastSuccess?.contentRevision).toBe(3);
});
test("a retained obsolete identity that is currently registered blocks cleanup", async () => {
  const f = deliveryFixture();
  const row = await f.read();
  row.updateDelivery.cleanupCandidates = [
    {
      sourceAttemptId: "prior",
      operationId: "delete-prior",
      registrationOperationId: "register-prior",
      channelId: f.input.messages[0].channel_id,
      messageId: f.input.messages[0].id,
      beforeFingerprint: "a".repeat(64),
    },
  ];
  f.setRow(row);
  expect((await run(f).promise).kind).toBe("blocked");
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect((await f.read()).updateDelivery.cleanupCandidates).toHaveLength(1);
});

test("explicit uncertain known-ID POST reconciliation observes creation content while retaining the hold", async () => {
  const f = deliveryFixture("old", "growth ".repeat(3000));
  f.intercept(async (method, id) => {
    if (method === "GET" && id.startsWith("900"))
      throw new Error("Readback interrupted");
    return undefined;
  });
  await run(f).promise;
  const row = await f.read();
  const progress = row.updateDelivery.progress;
  if (progress.kind !== "reconciling")
    throw new Error("Expected retained returned POST");
  const post = progress.operations.find(
    (item) => item.submission.kind === "returned",
  )!;
  const { nextCheckAt: _next, ...retained } = progress;
  void _next;
  row.updateDelivery.progress = {
    ...retained,
    kind: "uncertain",
    reason: "provider_outcome_unknown",
  };
  f.setRow(row);
  f.intercept(undefined);
  const mutations = f.calls.filter((call) => call.method !== "GET").length;
  const result = await run(f, true).promise;
  expect(result.kind).toBe("uncertain");
  expect(result.observations).toContainEqual({
    operationId: post.operationId,
    kind: "desired",
  });
  expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(
    mutations,
  );
  expect((await f.read()).updateDelivery.parts.notesBody.acknowledged).toBe(0);
});
