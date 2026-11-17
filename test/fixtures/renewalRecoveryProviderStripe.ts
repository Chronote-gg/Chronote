import { cancelUnpaidRenewal } from "../../src/services/renewalRecoveryProvider";
import {
  renewalRecoverySchema,
  type RenewalRecovery,
} from "../../src/types/renewalRecovery";
import {
  sourceSubscription,
  fundedInvoice,
  paidStartsAt,
  paidEndsAt,
} from "./renewalStripe";
import {
  stripeTransport,
  type StripeTransportRequest,
} from "./stripeTransport";

type Request = StripeTransportRequest;
export type ProviderWriteHooks = {
  /** Awaited before each mutating request reaches the fake provider. */
  beforeWrite?: (request: Request) => Promise<void>;
  /** Replays the first response for a repeated Idempotency-Key, as Stripe does. */
  honorIdempotencyKeys?: boolean;
};
function withProviderWrites(
  handle: (request: Request) => unknown,
  writes: ProviderWriteHooks,
): (request: Request) => Promise<unknown> {
  const replays = new Map<string, unknown>();
  return async (request) => {
    if (request.method === "GET") return handle(request);
    await writes.beforeWrite?.(request);
    const key = writes.honorIdempotencyKeys
      ? request.idempotencyKey
      : undefined;
    if (key && replays.has(key)) return replays.get(key);
    const response = handle(request);
    // A JSON snapshot, so later fixture mutations cannot change a replayed response.
    if (key) replays.set(key, JSON.parse(JSON.stringify(response)));
    return response;
  };
}
export function renewalProviderFixture(
  cash = 0,
  post = 0,
  tax = 0,
  extra = 0,
  writes: ProviderWriteHooks = {},
) {
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
  const handle = (request: Request): unknown => {
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
  };
  const transport = stripeTransport(withProviderWrites(handle, writes));
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
