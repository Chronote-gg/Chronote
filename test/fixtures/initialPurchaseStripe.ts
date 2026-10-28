import { sourceSubscription, fundedInvoice } from "./renewalStripe";
import { getMockStore } from "../../src/repositories/mockStore";
import type { StripeClient } from "../../src/types/stripe";

export const purchaseGuildId = "111111111111111111";

export function sessionFields() {
  const attempt = getMockStore().purchaseAttempts.get(purchaseGuildId);
  return {
    customer: "cus_first",
    livemode: false,
    metadata: {
      guild_id: purchaseGuildId,
      purchase_attempt_id: attempt?.attemptId ?? "",
    },
  };
}

type CheckoutSessionStub = ReturnType<typeof sessionFields> & {
  id: string;
  status: string;
  url?: string | null;
  subscription?: string | null;
};

export function paidProvider(id: string) {
  const metadata = {
    guild_id: purchaseGuildId,
    discord_id: "payer",
    purchase_attempt_id: "",
  };
  const native = {
    ...sourceSubscription,
    id,
    latest_invoice: "in_first",
    customer: "cus_first",
    metadata,
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      ...sourceSubscription.items,
      data: sourceSubscription.items.data.map((item) => ({
        ...item,
        price: { ...item.price, id: "price_basic" },
        current_period_start: 100,
        current_period_end: 200,
      })),
    },
  };
  const invoice = {
    ...fundedInvoice,
    id: "in_first",
    customer: "cus_first",
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: { subscription: id, metadata },
    },
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        period: { start: 100, end: 200 },
        pricing: {
          ...line.pricing,
          price_details: { price: "price_basic", product: "prod_renewal" },
        },
        parent: {
          ...line.parent,
          subscription_item_details: {
            ...line.parent?.subscription_item_details,
            subscription: id,
          },
        },
      })),
    },
  };
  return {
    subscriptions: {
      retrieve: jest.fn(async () => {
        metadata.purchase_attempt_id =
          getMockStore().purchaseAttempts.get(purchaseGuildId)?.attemptId ?? "";
        return native;
      }),
    },
    invoices: { retrieve: jest.fn(async () => invoice) },
  };
}

const expiredSession = (id: string): CheckoutSessionStub => ({
  ...sessionFields(),
  id,
  status: "expired",
  url: null,
  subscription: null,
});

/** `expire` marks a session expired at the provider, so later retrieves report it expired. */
export function initialPurchaseStripe() {
  const expired = new Set<string>();
  const stripe = {
    customers: {
      list: jest.fn(async () => ({ data: [], has_more: false })),
      create: jest.fn(async () => ({ id: "cus_first" })),
      retrieve: jest.fn(async () => ({
        id: "cus_first",
        metadata: { discord_id: "payer" },
      })),
    },
    checkout: {
      sessions: {
        create: jest.fn(async () => ({
          ...sessionFields(),
          id: "cs_first",
          status: "open",
          url: "https://checkout.stripe.com/first",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        })),
        retrieve: jest.fn(
          async (id = "cs_first"): Promise<CheckoutSessionStub> =>
            expired.has(id)
              ? expiredSession(id)
              : {
                  ...sessionFields(),
                  id,
                  status: "open",
                  url: "https://checkout.stripe.com/first",
                  subscription: null,
                },
        ),
        expire: jest.fn(async (id: string) => {
          expired.add(id);
          return expiredSession(id);
        }),
      },
    },
  };
  return { stripe, client: stripe as unknown as StripeClient };
}
