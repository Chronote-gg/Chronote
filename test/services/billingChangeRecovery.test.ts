/** @jest-environment node */
import {
  compensationAmounts,
  compensateChangeFunding,
} from "../../src/services/billingChangeRecovery";
import { billingChangeBase } from "../../src/types/billingChange";
import { changeOperation } from "../fixtures/billingChange";
import { fundedInvoice } from "../fixtures/renewalStripe";
import { stripeTransport } from "../fixtures/stripeTransport";
const operation = {
  ...billingChangeBase(changeOperation),
  draftInvoiceId: "in_funding",
  state: "canceling" as const,
  scheduleId: null,
  consent: null,
  funding: {
    invoiceId: "in_funding",
    total: 5700,
    amountDue: 6200,
    currency: "usd",
    startingBalance: 500,
    endingBalance: 0,
    serviceValue: 5700,
  },
  recovery: {
    creditNoteId: null,
    debtRefundId: null,
    balanceTransactionId: null,
  },
};
it.each([
  [
    5700,
    5500,
    {
      serviceRefund: 5500,
      serviceCredit: 200,
      debtRefund: 0,
      balanceReversal: 0,
    },
  ],
  [
    5700,
    6200,
    {
      serviceRefund: 5700,
      serviceCredit: 0,
      debtRefund: 500,
      balanceReversal: 0,
    },
  ],
  [
    5700,
    0,
    {
      serviceRefund: 0,
      serviceCredit: 5700,
      debtRefund: 0,
      balanceReversal: 0,
    },
  ],
  [
    -3600,
    0,
    {
      serviceRefund: 0,
      serviceCredit: 0,
      debtRefund: 0,
      balanceReversal: 3600,
    },
  ],
  [
    10,
    0,
    { serviceRefund: 0, serviceCredit: 10, debtRefund: 0, balanceReversal: 0 },
  ],
] as const)("reverses only owned funding %i/%i", (total, paid, want) => {
  expect(compensationAmounts(total, paid)).toEqual(want);
});
it("reverses service before old debt, restores only that debt, and resumes without duplicate refunds", async () => {
  let note: unknown = null;
  let refund: unknown = null;
  let adjustment: unknown = null;
  const journal: string[] = [];
  const native = {
    ...fundedInvoice,
    id: "in_funding",
    parent: null,
    customer: operation.source.customerId,
    total: 5700,
    amount_due: 6200,
    amount_paid: 6200,
    amount_remaining: 0,
    starting_balance: 500,
    ending_balance: 0,
    auto_advance: false,
    metadata: {
      guild_id: operation.guildId,
      chronote_change_operation: operation.operationId,
      chronote_invoice_role: "funding",
    },
  };
  function fundingRefund(
    path: string,
    method: string,
    fields: URLSearchParams,
  ) {
    if (path === "/v1/refunds/re_service")
      return {
        id: "re_service",
        amount: 5700,
        status: "succeeded",
        currency: "usd",
        charge: "ch_owned",
      };
    if (path === "/v1/invoice_payments")
      return {
        object: "list",
        has_more: false,
        data: [
          {
            id: "inpay_owned",
            invoice: "in_funding",
            status: "paid",
            amount_paid: 6200,
            livemode: false,
            payment: { type: "payment_intent", payment_intent: "pi_owned" },
          },
        ],
      };
    if (path === "/v1/payment_intents/pi_owned")
      return {
        id: "pi_owned",
        status: "succeeded",
        latest_charge: "ch_owned",
        livemode: false,
        customer: operation.source.customerId,
        amount_received: 6200,
        currency: "usd",
      };
    if (path === "/v1/refunds" && method === "GET")
      return { object: "list", has_more: false, data: refund ? [refund] : [] };
    if (path === "/v1/refunds" && method === "POST") {
      journal.push("debt");
      expect(fields.get("amount")).toBe("500");
      refund = {
        id: "re_debt",
        amount: 500,
        status: "succeeded",
        charge: "ch_owned",
        livemode: false,
        currency: "usd",
        metadata: {
          chronote_change_operation: operation.operationId,
          chronote_refund_role: "prior-balance",
        },
      };
      return refund;
    }
    return undefined;
  }
  const f = stripeTransport(({ path, method, fields }) => {
    if (path === "/v1/invoices/in_funding") return native;
    if (path === "/v1/credit_notes" && method === "GET")
      return { object: "list", data: note ? [note] : [], has_more: false };
    if (path === "/v1/credit_notes" && method === "POST") {
      journal.push("service");
      expect(fields.get("refund_amount")).toBe("5700");
      expect(fields.has("credit_amount")).toBe(false);
      note = {
        id: "cn_owned",
        invoice: "in_funding",
        amount: 5700,
        status: "issued",
        livemode: false,
        customer: operation.source.customerId,
        metadata: { chronote_change_operation: operation.operationId },
        refunds: [{ amount_refunded: 5700, refund: "re_service" }],
      };
      return note;
    }
    const refundedFunding = fundingRefund(path, method, fields);
    if (refundedFunding) return refundedFunding;
    if (path.endsWith("/balance_transactions") && method === "GET")
      return {
        object: "list",
        has_more: false,
        data: adjustment ? [adjustment] : [],
      };
    if (path.endsWith("/balance_transactions") && method === "POST") {
      journal.push("restore");
      expect(fields.get("amount")).toBe("500");
      adjustment = {
        id: "cbtxn_owned",
        amount: 500,
        currency: "usd",
        livemode: false,
        metadata: {
          chronote_change_operation: operation.operationId,
          chronote_balance_role: "prior-balance",
        },
      };
      return adjustment;
    }
    throw new Error(`Unexpected native request ${method} ${path}`);
  });
  const progress: unknown[] = [];
  const first = await compensateChangeFunding({
    stripe: f.stripe,
    operation,
    onProgress: async (receipt) => {
      progress.push(receipt);
    },
  });
  expect(first).toEqual({
    creditNoteId: "cn_owned",
    debtRefundId: "re_debt",
    balanceTransactionId: "cbtxn_owned",
  });
  expect(journal).toEqual(["service", "debt", "restore"]);
  await compensateChangeFunding({
    stripe: f.stripe,
    operation,
    onProgress: async () => {},
  });
  expect(journal).toEqual(["service", "debt", "restore"]);
  expect(progress.length).toBeGreaterThan(0);
});

it("holds recovery until the service refund has actually succeeded", async () => {
  const f = stripeTransport(({ path }) => {
    if (path === "/v1/invoices/in_funding")
      return {
        ...fundedInvoice,
        id: "in_funding",
        parent: null,
        customer: operation.source.customerId,
        auto_advance: false,
        total: 5700,
        amount_paid: 5700,
        amount_remaining: 0,
        metadata: {
          guild_id: operation.guildId,
          chronote_change_operation: operation.operationId,
          chronote_invoice_role: "funding",
        },
      };
    if (path === "/v1/credit_notes")
      return {
        object: "list",
        has_more: false,
        data: [
          {
            id: "cn_pending",
            status: "issued",
            invoice: "in_funding",
            amount: 5700,
            customer: operation.source.customerId,
            livemode: false,
            metadata: { chronote_change_operation: operation.operationId },
            refunds: [{ refund: "re_pending", amount_refunded: 5700 }],
          },
        ],
      };
    if (path === "/v1/refunds/re_pending")
      return {
        id: "re_pending",
        amount: 5700,
        status: "pending",
        currency: "usd",
        livemode: false,
      };
    throw new Error(`Unexpected ${path}`);
  });
  await expect(
    compensateChangeFunding({
      stripe: f.stripe,
      operation,
      onProgress: async () => {},
    }),
  ).rejects.toThrow();
});
