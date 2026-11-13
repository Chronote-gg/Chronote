/** @jest-environment node */
import { cancelUnpaidRenewal } from "../../src/services/renewalRecoveryProvider";
import { renewalRecoveryKey } from "../../src/types/renewalRecovery";
import { config } from "../../src/services/configService";
import { fundedInvoice, paidEndsAt } from "../fixtures/renewalStripe";
import { renewalProviderFixture as fixture } from "../fixtures/renewalRecoveryProviderStripe";

const originalMode = config.subscription.stripeMode;
beforeEach(() => {
  config.subscription.stripeMode = "test";
});
afterEach(() => {
  config.subscription.stripeMode = originalMode;
});
test("cancels only the unpaid plan and restores unrelated automatic collection", async () => {
  const f = fixture();
  expect(await f.run()).toBe("canceled");
  expect(f.native.status).toBe("canceled");
  expect(f.other.total).toBe(200);
  expect(f.other.auto_advance).toBe(true);
  expect(f.recovery).toMatchObject({
    state: "canceling",
    receipts: { creditNoteId: "cn_owned", canceled: true },
  });
  const request = f.requests.find(
    (request) =>
      request.path === "/v1/credit_notes" && request.method === "POST",
  );
  expect(request?.fields.has("refund_amount")).toBe(false);
  expect(request?.fields.has("credit_amount")).toBe(false);
  expect(
    f.requests
      .find((request) => request.method === "DELETE")
      ?.fields.get("prorate"),
  ).toBe("false");
});
test.each([
  [300, 300, 0],
  [0, 900, 0],
  [300, 500, 0],
  [0, 0, 100],
])(
  "uses native preview allocation for cash=%s post=%s tax=%s",
  async (cash, post, tax) => {
    const f = fixture(cash, post, tax);
    expect(await f.run()).toBe("canceled");
    const request = f.requests.find(
      (request) =>
        request.path === "/v1/credit_notes" && request.method === "POST",
    );
    expect(Number(request?.fields.get("refund_amount") ?? 0)).toBe(
      Math.min(cash, post),
    );
    expect(Number(request?.fields.get("credit_amount") ?? 0)).toBe(
      post - Math.min(cash, post),
    );
  },
);
test("recovers an unacknowledged credit note without issuing it twice", async () => {
  const f = fixture();
  f.loseNote();
  await expect(f.run()).rejects.toThrow();
  expect(await f.run()).toBe("canceled");
  expect(f.notes).toHaveLength(1);
});
test("recovers cancellation after its provider acknowledgement is lost", async () => {
  const f = fixture();
  f.loseCancel();
  await expect(f.run()).rejects.toThrow();
  expect(await f.run()).toBe("canceled");
  expect(f.notes).toHaveLength(1);
  expect(f.other.auto_advance).toBe(true);
});
test("lets a payment that settled before cleanup complete the renewal", async () => {
  const f = fixture();
  f.invoice.status = "paid";
  f.invoice.amount_remaining = 0;
  expect(await f.run()).toBe("paid");
  expect(f.notes).toHaveLength(0);
  expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
});
test("retains its recoverable receipt when native cancellation fails", async () => {
  const f = fixture();
  f.failCancellation(true);
  await expect(f.run()).rejects.toThrow();
  expect(f.recovery).toMatchObject({
    receipts: { creditNoteId: "cn_owned", canceled: false },
  });
  f.failCancellation(false);
  expect(await f.run()).toBe("canceled");
  expect(f.notes).toHaveLength(1);
});
test("stops before financial writes when the receipt cannot be saved", async () => {
  const f = fixture();
  await expect(f.run(true)).rejects.toThrow("Receipt persistence unavailable");
  expect(f.notes).toHaveLength(0);
  expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
});
test("refuses cross-mode, foreign-customer and stale plan-line evidence", async () => {
  for (const mismatch of ["mode", "customer", "line"]) {
    const f = fixture();
    if (mismatch === "mode") f.invoice.livemode = true;
    if (mismatch === "customer") f.invoice.customer = "cus_other";
    if (mismatch === "line") f.invoice.lines.data[0].id = "il_other";
    await expect(f.run()).rejects.toThrow();
    expect(f.notes).toHaveLength(0);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(
      false,
    );
  }
});
test("uses a cycle-specific recovery marker", () => {
  expect(renewalRecoveryKey(fixture().recovery)).toContain("sub_renewal");
});

test("holds recovery while the same invoice payment is processing", async () => {
  const f = fixture();
  f.processing();
  expect(await f.run()).toBe("pending");
  expect(f.notes).toHaveLength(0);
  expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
});
test("honors payment that wins the pause race before the credit note", async () => {
  const f = fixture();
  f.payOnPause();
  expect(await f.run()).toBe("paid");
  expect(f.notes).toHaveLength(0);
  expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
});

test("holds cleanup when payment starts processing during invoice pause", async () => {
  const f = fixture();
  f.processingOnPause();
  expect(await f.run()).toBe("pending");
  expect(f.notes).toHaveLength(0);
  expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
});
test.each([1, 2, 3, 4, 5])(
  "resumes safely after receipt %s cannot persist",
  async (stage) => {
    const f = fixture();
    await expect(f.run(stage)).rejects.toThrow(
      "Receipt persistence unavailable",
    );
    expect(await f.run()).toBe("canceled");
    expect(f.notes).toHaveLength(1);
    expect(f.recovery).toMatchObject({
      receipts: { canceled: true, collectionRestored: true },
    });
  },
);

test.each([1, 2, 3, 4, 5])(
  "fences every native mutation boundary after write %s and resumes from receipts",
  async (stage) => {
    const f = fixture();
    const controller = new AbortController();
    let writes = 0;
    const result = cancelUnpaidRenewal({
      stripe: f.stripe,
      recovery: f.recovery,
      now: paidEndsAt + 4000,
      signal: controller.signal,
      onReceipt: async (next) => {
        f.recovery = next;
      },
      effect: async (run) => {
        const value = await run();
        if (++writes === stage) controller.abort();
        return value;
      },
    });
    if (stage < 5) await expect(result).rejects.toThrow();
    else expect(await result).toBe("canceled");
    expect(writes).toBe(stage);
    expect(await f.run()).toBe("canceled");
    expect(f.notes).toHaveLength(1);
    expect(f.other.auto_advance).toBe(true);
  },
);

test("does not re-enable an unrelated invoice manually stopped during financial cleanup", async () => {
  const f = fixture();
  f.manualCollectionStop();
  expect(await f.run()).toBe("canceled");
  expect(f.other.auto_advance).toBe(false);
});
test("a recovery replay preserves a later manual collection change", async () => {
  const f = fixture();
  expect(await f.run()).toBe("canceled");
  f.other.auto_advance = false;
  expect(await f.run()).toBe("canceled");
  expect(f.other.auto_advance).toBe(false);
});

test("preserves unrelated debt on the same invoice and restores its own paused collection", async () => {
  const f = fixture(300, 500, 0, 200);
  expect(await f.run()).toBe("canceled");
  expect(f.invoice).toMatchObject({
    status: "open",
    amount_remaining: 200,
    auto_advance: true,
  });
  expect(
    f.invoice.lines.data.find((line) => line.id === "il_unrelated")?.amount,
  ).toBe(200);
  expect(f.other.parent.subscription_details.subscription).toBe("sub_other");
  expect(
    f.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.path),
  ).toEqual([`/v1/subscriptions/${f.native.id}`]);
});
test("native restoration marker survives a lost acknowledgment and preserves a later manual stop", async () => {
  const f = fixture();
  f.loseRestore();
  await expect(f.run()).rejects.toThrow();
  f.other.auto_advance = false;
  expect(await f.run()).toBe("canceled");
  expect(f.other.auto_advance).toBe(false);
});

test("preserves an unrelated invoice created between the initial snapshot and cancellation retry", async () => {
  const f = fixture();
  f.showOther(false);
  await expect(f.run(2)).rejects.toThrow("Receipt persistence unavailable");
  f.showOther(true);
  expect(f.other.auto_advance).toBe(true);
  expect(await f.run()).toBe("canceled");
  expect(f.other.auto_advance).toBe(true);
});
test("cleans an uncollectible renewal without trying to update the forgiven invoice", async () => {
  const f = fixture();
  f.invoice.status = "uncollectible";
  f.invoice.auto_advance = false;
  expect(await f.run()).toBe("canceled");
  expect(f.native.status).toBe("canceled");
  expect(
    f.requests.some(
      (request) =>
        request.path === `/v1/invoices/${f.invoice.id}` &&
        request.method === "POST",
    ),
  ).toBe(false);
});
test("preserves a newer verified paid period when old compensation is retried", async () => {
  const f = fixture();
  await expect(f.run(2)).rejects.toThrow("Receipt persistence unavailable");
  const item = f.native.items.data[0];
  const start = item.current_period_end;
  f.native.status = "active";
  f.native.latest_invoice = "in_new_paid_period";
  item.current_period_start = start;
  item.current_period_end = start + 2592000;
  const current = {
    ...fundedInvoice,
    id: f.native.latest_invoice,
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        invoice: "in_new_paid_period",
        period: { start, end: item.current_period_end },
      })),
    },
  };
  f.additionalInvoices.set(current.id, current);
  expect(await f.run()).toMatchObject({
    kind: "superseded",
    paid: { invoiceId: current.id, periodEnd: item.current_period_end },
  });
  expect(f.native.status).toBe("active");
  expect(
    f.requests.some((request) => request.path === `/v1/invoices/${current.id}`),
  ).toBe(true);
  expect(f.requests.some((request) => request.method === "DELETE")).toBe(false);
});

test("retains recovery when cancellation reveals an unjournaled invoice with unknown collection intent", async () => {
  const f = fixture();
  f.showOther(false);
  f.appearOnCancellation();
  await expect(f.run()).rejects.toThrow();
  expect(f.other.auto_advance).toBe(false);
  await expect(f.run()).rejects.toThrow();
  expect(f.recovery).toMatchObject({
    state: "canceling",
    receipts: { collectionRestored: false },
  });
  expect(
    f.requests.some(
      (request) =>
        request.path === `/v1/invoices/${f.other.id}` &&
        request.method === "POST",
    ),
  ).toBe(false);
});

test.each([null, "sub_sched_already_canceled"])(
  "finishes a verified portal cancellation with schedule %s while preserving its current collection settings",
  async (schedule) => {
    const f = fixture();
    f.native.status = "canceled";
    f.native.schedule = schedule;
    f.invoice.auto_advance = false;
    f.other.auto_advance = false;
    expect(await f.run()).toBe("canceled");
    expect(f.recovery).toMatchObject({
      receipts: { canceled: true, collectionRestored: true },
    });
    expect(f.other.auto_advance).toBe(false);
    expect(
      f.requests.filter(
        (r) => r.path.includes("subscriptions") && r.method !== "GET",
      ),
    ).toHaveLength(0);
    expect(await f.run()).toBe("canceled");
    expect(f.notes).toHaveLength(1);
  },
);
