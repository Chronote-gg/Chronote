/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { seedBillingRuntime, context } from "../fixtures/billingRuntime";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getStripeWebhookRepository } from "../../src/repositories/stripeWebhookRepository";
import type { StripeWebhookEvent } from "../../src/types/db";
import { STRIPE_RECEIPT_BOUNDARY } from "../../src/types/stripeWebhookReceipt";
const birth = { version: STRIPE_RECEIPT_BOUNDARY, writer: context.identity };
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
  seedBillingRuntime();
});
test.each(["legacy", "admitted", "unadmitted"])(
  "expired %s retry preserves immutable origin/history",
  async (kind) => {
    const original = event();
    const repo = getStripeWebhookRepository();
    await repo.claim(original);
    if (kind === "admitted")
      await repo.admit(original.eventId, "token", randomUUID(), context);
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
      await repo.admit(original.eventId, "replacement", randomUUID(), context),
    ).toBe(kind === "unadmitted");
  },
);
test("first admission survives a definite pre-mutation retry", async () => {
  const row = event(),
    repo = getStripeWebhookRepository();
  await repo.claim(row);
  expect(await repo.admit(row.eventId, "token", randomUUID(), context)).toBe(
    true,
  );
  const first = (await repo.get(row.eventId))?.firstAdmission;
  expect(await repo.fail(row.eventId, "token")).toBe(true);
  await repo.claim({ ...row, leaseToken: "next" });
  expect(await repo.admit(row.eventId, "token", randomUUID(), context)).toBe(
    false,
  );
  expect(await repo.finish(row.eventId, "token")).toBe(false);
  expect(await repo.admit(row.eventId, "next", randomUUID(), context)).toBe(
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
  await repo.admit(row.eventId, "token", randomUUID(), context);
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
    await repo.admit(row.eventId, "token", randomUUID(), context);
    await repo.fail(row.eventId, "token");
    const saved = (await repo.get(row.eventId))!;
    if (corruption === "missing first") delete saved.firstAdmission;
    if (corruption === "malformed first")
      Object.assign(saved, { firstAdmission: {} });
    if (corruption === "malformed attempt")
      Object.assign(saved, { admission: { status: "failed" } });
    getMockStore().stripeWebhookEvents.set(row.eventId, saved);
    expect(await repo.claim({ ...row, leaseToken: "next" })).toBe(true);
    expect(await repo.admit(row.eventId, "next", randomUUID(), context)).toBe(
      false,
    );
    const after = (await repo.get(row.eventId))!;
    expect(after.firstAdmission).toEqual(saved.firstAdmission);
    expect(after.admission).toEqual(saved.admission);
  },
);
