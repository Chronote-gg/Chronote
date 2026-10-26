/** @jest-environment node */
import { cancelUnpaidRenewal } from "../../src/services/renewalRecoveryProvider";
import {
  renewalRecoverySchema,
  renewalRecoveryKey,
  type RenewalRecovery,
} from "../../src/types/renewalRecovery";
import { config } from "../../src/services/configService";
import {
  sourceSubscription,
  fundedInvoice,
  paidStartsAt,
  paidEndsAt,
} from "../fixtures/renewalStripe";
import { stripeTransport } from "../fixtures/stripeTransport";

const originalMode = config.subscription.stripeMode;
beforeEach(() => {
  config.subscription.stripeMode = "test";
});
afterEach(() => {
  config.subscription.stripeMode = originalMode;
});
function fixture(cash = 0, post = 0, tax = 0, extra = 0) {
  const native = {
    ...sourceSubscription,
    metadata: { ...sourceSubscription.metadata },
    status: "past_due" as typeof sourceSubscription.status,
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      ...sourceSubscription.items,
      data: sourceSubscription.items.data.map((item) => ({
        ...item,
        current_period_start: paidEndsAt,
        current_period_end: paidEndsAt + 2592000,
      })),
    },
  };
  const invoice = {
    ...fundedInvoice,
    id: "in_renewal",
    metadata: {},
    status: "open" as typeof fundedInvoice.status,
    amount_paid: cash,
    amount_remaining: 1000 + tax + extra - cash,
    amount_due: 1000 + tax + extra,
    total: 1000 + tax + extra,
    auto_advance: true,
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        id: "il_renewal",
        period: { start: paidEndsAt, end: paidEndsAt + 2592000 },
      })),
    },
    status_transitions: {
      ...fundedInvoice.status_transitions,
      finalized_at: paidEndsAt + 3600,
    },
  };
  if (extra)
    invoice.lines.data.push({
      ...invoice.lines.data[0],
      id: "il_unrelated",
      amount: extra,
    });
  const other = {
    ...fundedInvoice,
    id: "in_other",
    parent: {
      type: "subscription_details" as const,
      quote_details: null,
      subscription_details: { metadata: {}, subscription: "sub_other" },
    },
    metadata: {},
    status: "open" as const,
    auto_advance: true,
    amount_remaining: 200,
    total: 200,
  };
  let recovery = renewalRecoverySchema.parse({
    guildId: native.metadata.guild_id,
    subscriptionId: native.id,
    customerId: "cus_renewal",
    payerId: native.metadata.discord_id,
    mode: "test",
    revision: "r1",
    paid: {
      invoiceId: fundedInvoice.id,
      priceId: "price_renewal",
      tier: "pro",
      interval: "month",
      periodStart: paidStartsAt,
      periodEnd: paidEndsAt,
    },
    scheduledOperationId: null,
    enforcementAccepted: true,
    state: "canceling",
    nextCheckAt: paidEndsAt + 4000,
    reason: "payer",
    invoice: {
      id: invoice.id,
      lineId: "il_renewal",
      finalizedAt: paidEndsAt + 3600,
      periodStart: paidEndsAt,
      periodEnd: paidEndsAt + 2592000,
    },
    endsAt: paidEndsAt + 3600 + 172800,
    receipts: { creditNoteId: null, refundIds: [], canceled: false },
  });
  const notes: object[] = [];
  let otherVisible = true;
  let appearOnCancellation = false;
  const additionalInvoices = new Map<string, typeof fundedInvoice>();
  let loseNoteAck = false;
  let failCancel = false;
  let loseCancelAck = false;
  let writesAfterFailedReceipt = 0;
  let processing = false;
  let payOnPause = false;
  let processingOnPause = false;
  let manualCollectionStop = false;
  let loseRestoreAck = false;
  type Request = { path: string; method: string; fields: URLSearchParams };
  function subscriptionRequest({ path, method, fields }: Request): unknown {
    if (path === "/v1/customers/cus_renewal")
      return {
        id: "cus_renewal",
        livemode: false,
        metadata: { discord_id: native.metadata.discord_id },
      };
    if (path === `/v1/subscriptions/${native.id}` && method === "GET")
      return native;
    if (path === `/v1/subscriptions/${native.id}` && method === "POST") {
      native.metadata = {
        ...native.metadata,
        chronote_renewal_recovery:
          fields.get("metadata[chronote_renewal_recovery]") ?? "",
      };
      return native;
    }
    if (path === `/v1/subscriptions/${native.id}` && method === "DELETE") {
      if (failCancel) throw new Error("Provider cancellation unavailable");
      native.status = "canceled";
      if (appearOnCancellation) otherVisible = true;
      other.auto_advance = false;
      if (loseCancelAck) {
        loseCancelAck = false;
        throw new Error("Lost cancellation acknowledgement");
      }
      return native;
    }
    return undefined;
  }
  function readAdditionalInvoice(path: string, method: string) {
    if (method !== "GET") return undefined;
    return additionalInvoices.get(path.split("/").at(-1) ?? "");
  }
  function serviceRequest({ path, method, fields }: Request): unknown {
    if (path === "/v1/invoices")
      return {
        object: "list",
        data: otherVisible ? [invoice, other] : [invoice],
        has_more: false,
        url: path,
      };
    const additional = readAdditionalInvoice(path, method);
    if (additional) return additional;
    if (path === `/v1/invoices/${invoice.id}` && method === "GET")
      return invoice;
    if (path === `/v1/invoices/${other.id}` && method === "GET") return other;
    if (path.startsWith("/v1/invoices/") && method === "POST") {
      if (path.endsWith(invoice.id) && invoice.status === "uncollectible")
        throw new Error("Forgiven invoices cannot be updated");
      return updateInvoice(path.endsWith(other.id) ? other : invoice, fields);
    }
    return undefined;
  }
  function updateInvoice(
    target: Pick<typeof invoice, "id" | "auto_advance" | "metadata">,
    fields: URLSearchParams,
  ): unknown {
    if (fields.has("auto_advance"))
      target.auto_advance = fields.get("auto_advance") === "true";
    if (payOnPause && target.id === invoice.id) {
      invoice.status = "paid";
      invoice.amount_remaining = 0;
    }
    if (processingOnPause && target.id === invoice.id) processing = true;
    for (const [key, value] of fields) {
      const match = /^metadata\[(.+)\]$/.exec(key);
      if (match) target.metadata = { ...target.metadata, [match[1]]: value };
    }
    if (
      loseRestoreAck &&
      target.id === other.id &&
      fields.get("auto_advance") === "true"
    ) {
      loseRestoreAck = false;
      throw new Error("Lost collection restoration acknowledgement");
    }
    return target;
  }
  function createNote(fields: URLSearchParams): unknown {
    const refund = Number(fields.get("refund_amount") ?? 0);
    const credit = Number(fields.get("credit_amount") ?? 0);
    expect(fields.get("lines[0][invoice_line_item]")).toBe("il_renewal");
    expect(fields.get("lines[0][quantity]")).toBe("1");
    expect(refund + credit).toBe(post);
    const note = {
      id: "cn_owned",
      status: "issued",
      invoice: invoice.id,
      customer: "cus_renewal",
      livemode: false,
      amount: 1000 + tax,
      currency: "usd",
      pre_payment_amount: 1000 + tax - post,
      post_payment_amount: post,
      metadata: {
        chronote_renewal_recovery: fields.get(
          "metadata[chronote_renewal_recovery]",
        ),
        chronote_recovery_refund: String(refund),
        chronote_recovery_credit: String(credit),
      },
      lines: {
        has_more: false,
        data: [{ invoice_line_item: "il_renewal", quantity: 1 }],
      },
      refunds: refund ? [{ refund: "re_owned", amount_refunded: refund }] : [],
      customer_balance_transaction: credit ? "cbt_owned" : null,
    };
    if (manualCollectionStop) other.auto_advance = false;
    notes.push(note);
    invoice.pre_payment_credit_notes_amount = note.pre_payment_amount;
    invoice.post_payment_credit_notes_amount = post;
    invoice.amount_remaining = extra;
    invoice.status = extra ? "open" : "paid";
    if (loseNoteAck) {
      loseNoteAck = false;
      throw new Error("Lost credit note acknowledgement");
    }
    return note;
  }
  const transport = stripeTransport((request) => {
    const subscription = subscriptionRequest(request);
    if (subscription !== undefined) return subscription;
    const service = serviceRequest(request);
    if (service !== undefined) return service;
    const { path, method, fields } = request;
    if (path === "/v1/credit_notes" && method === "GET")
      return { object: "list", data: notes, has_more: false, url: path };
    if (path === "/v1/credit_notes/preview")
      return {
        amount: 1000 + tax,
        pre_payment_amount: 1000 + tax - post,
        post_payment_amount: post,
        currency: "usd",
        lines: {
          has_more: false,
          data: [{ invoice_line_item: "il_renewal", quantity: 1 }],
        },
      };
    if (path === "/v1/credit_notes" && method === "POST")
      return createNote(fields);
    if (path === "/v1/refunds/re_owned")
      return {
        id: "re_owned",
        status: "succeeded",
        amount: Math.min(cash, post),
        currency: "usd",
        livemode: false,
        charge: "ch_owned",
      };
    if (path === "/v1/invoice_payments")
      return {
        object: "list",
        data: [
          {
            invoice: invoice.id,
            livemode: false,
            currency: "usd",
            status: processing ? "open" : "paid",
            amount_paid: cash,
            payment: { type: "payment_intent", payment_intent: "pi_owned" },
          },
        ],
        has_more: false,
        url: path,
      };
    if (path === "/v1/payment_intents/pi_owned")
      return {
        id: "pi_owned",
        status: processing ? "processing" : "succeeded",
        customer: "cus_renewal",
        livemode: false,
        currency: "usd",
        amount_received: cash,
        latest_charge: "ch_owned",
      };
    if (path === "/v1/customers/cus_renewal/balance_transactions/cbt_owned")
      return {
        id: "cbt_owned",
        amount: -(post - Math.min(cash, post)),
        currency: "usd",
      };
    writesAfterFailedReceipt++;
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  const run = (rejectReceipt: boolean | number = false) =>
    cancelUnpaidRenewal({
      stripe: transport.stripe,
      recovery,
      now: paidEndsAt + 4000,
      onReceipt: async (next) => {
        if (
          rejectReceipt === true ||
          (typeof rejectReceipt === "number" && --rejectReceipt === 0)
        )
          throw new Error("Receipt persistence unavailable");
        recovery = next;
      },
    });
  return {
    ...transport,
    native,
    additionalInvoices,
    showOther(value: boolean) {
      otherVisible = value;
    },
    appearOnCancellation() {
      appearOnCancellation = true;
    },
    invoice,
    other,
    notes,
    run,
    get recovery() {
      return recovery;
    },
    set recovery(value: RenewalRecovery) {
      recovery = value;
    },
    loseRestore() {
      loseRestoreAck = true;
    },
    manualCollectionStop() {
      manualCollectionStop = true;
    },
    processingOnPause() {
      processingOnPause = true;
    },
    processing() {
      processing = true;
    },
    payOnPause() {
      payOnPause = true;
    },
    loseNote() {
      loseNoteAck = true;
    },
    loseCancel() {
      loseCancelAck = true;
    },
    failCancellation(value: boolean) {
      failCancel = value;
    },
    get unexpected() {
      return writesAfterFailedReceipt;
    },
  };
}
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
