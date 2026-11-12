/** @jest-environment node */
import { randomUUID } from "node:crypto";
import type { RuntimeIdentity } from "../../src/types/deploymentControl";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getStripeWebhookRepository } from "../../src/repositories/stripeWebhookRepository";
import type { StripeWebhookEvent } from "../../src/types/db";
import { STRIPE_RECEIPT_BOUNDARY } from "../../src/types/stripeWebhookReceipt";
const runtime: RuntimeIdentity = {
  kind: "ecs",
  instanceId: "old",
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/fixture/old",
  imageDigest: "sha256:fixture",
  candidateId: "old",
  protocolVersion: 1,
};
const birth = { version: STRIPE_RECEIPT_BOUNDARY, writer: runtime };
const event = (id = randomUUID()): StripeWebhookEvent => ({
  eventId: id,
  state: "processing",
  leaseToken: "token",
  leaseUntil: Date.now() + 60000,
  receivedAt: "original",
  expiresAt: 1,
  birth,
  continuation: "not_admitted",
});
beforeEach(() => {
  config.mock.enabled = true;
  resetMockStore();
});
test.each(["legacy", "admitted", "unadmitted"])(
  "expired %s retry preserves immutable origin/history",
  async (kind) => {
    const original = event();
    const repo = getStripeWebhookRepository();
    await repo.claim(original);
    if (kind === "admitted")
      await repo.admit(original.eventId, "token", randomUUID(), runtime);
    const stored = getMockStore().stripeWebhookEvents.get(original.eventId)!;
    if (kind === "legacy") {
      delete stored.birth;
      delete stored.continuation;
    }
    stored.leaseUntil = 0;
    const before = structuredClone(stored);
    expect(
      await repo.claim({
        ...event(original.eventId),
        leaseToken: "replacement",
        receivedAt: "replacement",
      }),
    ).toBe(true);
    const after = await repo.get(original.eventId);
    expect(after).toEqual({
      ...before,
      leaseToken: "replacement",
      leaseUntil: expect.any(Number),
    });
    expect(after?.expiresAt).toBeUndefined();
    expect(
      await repo.admit(original.eventId, "replacement", randomUUID(), runtime),
    ).toBe(kind === "unadmitted");
  },
);
test("first admission survives a definite pre-mutation retry", async () => {
  const row = event(),
    repo = getStripeWebhookRepository();
  await repo.claim(row);
  expect(await repo.admit(row.eventId, "token", randomUUID(), runtime)).toBe(
    true,
  );
  const first = (await repo.get(row.eventId))?.firstAdmission;
  expect(await repo.fail(row.eventId, "token")).toBe(true);
  await repo.claim({ ...row, leaseToken: "next" });
  expect(await repo.admit(row.eventId, "token", randomUUID(), runtime)).toBe(
    false,
  );
  expect(await repo.finish(row.eventId, "token")).toBe(false);
  expect(await repo.admit(row.eventId, "next", randomUUID(), runtime)).toBe(
    true,
  );
  expect((await repo.get(row.eventId))?.firstAdmission).toEqual(first);
  expect(await repo.finish(row.eventId, "next")).toBe(true);
  expect((await repo.get(row.eventId))?.expiresAt).toBeGreaterThan(
    Date.now() / 1000,
  );
});
test("failed release preserves receipt and unresolved admission", async () => {
  const row = event(),
    repo = getStripeWebhookRepository();
  await repo.claim(row);
  await repo.admit(row.eventId, "token", randomUUID(), runtime);
  await repo.finish(row.eventId, "token", true);
  const after = await repo.get(row.eventId);
  expect(after?.firstAdmission).toBeDefined();
  expect(after?.admission?.status).toBe("running");
});

test.each(["missing first", "malformed first", "malformed attempt"])(
  "failed retry refuses %s admission history",
  async (corruption) => {
    const row = event();
    const repo = getStripeWebhookRepository();
    await repo.claim(row);
    await repo.admit(row.eventId, "token", randomUUID(), runtime);
    await repo.fail(row.eventId, "token");
    const saved = (await repo.get(row.eventId))!;
    if (corruption === "missing first") delete saved.firstAdmission;
    if (corruption === "malformed first")
      Object.assign(saved, { firstAdmission: {} });
    if (corruption === "malformed attempt")
      Object.assign(saved, { admission: { status: "failed" } });
    getMockStore().stripeWebhookEvents.set(row.eventId, saved);
    expect(await repo.claim({ ...row, leaseToken: "next" })).toBe(true);
    expect(await repo.admit(row.eventId, "next", randomUUID(), runtime)).toBe(
      false,
    );
    const after = (await repo.get(row.eventId))!;
    expect(after.firstAdmission).toEqual(saved.firstAdmission);
    expect(after.admission).toEqual(saved.admission);
  },
);

test("admission runs without any deployment control record and records the supplied identity", async () => {
  const row = event(),
    repo = getStripeWebhookRepository();
  await repo.claim(row);
  const attemptId = randomUUID();
  const before = Math.floor(Date.now() / 1000);
  expect(getMockStore().deploymentControlRecords.size).toBe(0);
  expect(await repo.admit(row.eventId, "token", attemptId, runtime)).toBe(true);
  const admission = {
    attemptId,
    leaseToken: "token",
    runtime,
    generation: config.runtime.release,
    admittedAt: expect.any(Number),
  };
  const stored = await repo.get(row.eventId);
  expect(stored).toMatchObject({
    continuation: "admitted",
    firstAdmission: admission,
    admission: { ...admission, status: "running" },
  });
  expect(stored?.firstAdmission?.admittedAt).toBeGreaterThanOrEqual(before);
  expect(stored?.birth).toEqual(birth);
});
test("a stored receipt admitted under the deployment authority still continues", async () => {
  const row = event(),
    repo = getStripeWebhookRepository();
  const legacy = {
    attemptId: randomUUID(),
    leaseToken: "token",
    runtime,
    generation: 7,
    admittedAt: 100,
  };
  await repo.tryCreate({
    ...row,
    leaseToken: "next",
    continuation: "admitted",
    firstAdmission: legacy,
    admission: { ...legacy, status: "failed" },
  });
  expect(await repo.admit(row.eventId, "next", randomUUID(), runtime)).toBe(
    true,
  );
  expect((await repo.get(row.eventId))?.firstAdmission).toEqual(legacy);
  expect(await repo.finish(row.eventId, "next")).toBe(true);
});
