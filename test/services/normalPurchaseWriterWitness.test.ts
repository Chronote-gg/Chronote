/** @jest-environment node */
import { normalPurchaseWriterWitness } from "../../src/services/normalPurchaseWriterWitness";
import type { PurchaseAttempt } from "../../src/types/purchase";
const attempt: PurchaseAttempt = {
  guildId: "111111111111111111",
  attemptId: "op",
  revision: "r",
  payerId: "payer",
  mode: "test",
  fingerprint: "f",
  createdAt: 100,
  state: "open",
  customerId: "cus",
  checkout: { line_items: [{ price: "price", quantity: 1 }] },
};
const runtime = {
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/task-one",
  imageDigest: "sha256:" + "a".repeat(64),
};
const subscription = { id: "sub", customer: "cus", livemode: false };
const invoice = {
  id: "in",
  customer: "cus",
  livemode: false,
  status: "paid",
  amount_remaining: 0,
  billing_reason: "subscription_create",
  parent: {
    subscription_details: {
      subscription: "sub",
      metadata: {
        guild_id: attempt.guildId,
        purchase_attempt_id: "op",
        discord_id: "payer",
      },
    },
  },
  lines: {
    has_more: false,
    data: [
      {
        quantity: 1,
        pricing: { price_details: { price: "price" } },
        parent: {
          subscription_item_details: { subscription: "sub", proration: false },
        },
      },
    ],
  },
};
test("a regular initial paid purchase can witness the actual deployed writer without activating an introductory offer", () => {
  expect(
    normalPurchaseWriterWitness(
      attempt,
      subscription,
      invoice as never,
      runtime,
    ),
  ).toEqual({ ...runtime, writerVersion: "offer-ledger-v1", invoiceId: "in" });
});
test.each(["customer", "status", "billing_reason", "livemode"] as const)(
  "wrong initial invoice %s cannot witness deployment",
  (key) => {
    const other = { ...invoice, [key]: key === "livemode" ? true : "other" };
    expect(
      normalPurchaseWriterWitness(
        attempt,
        subscription,
        other as never,
        runtime,
      ),
    ).toBeUndefined();
  },
);
test("a mismatched or prorated price line cannot witness normal first-purchase acceptance", () => {
  const other = {
    ...invoice,
    lines: {
      has_more: false,
      data: [
        {
          ...invoice.lines.data[0],
          pricing: { price_details: { price: "different" } },
        },
      ],
    },
  };
  expect(
    normalPurchaseWriterWitness(attempt, subscription, other as never, runtime),
  ).toBeUndefined();
});
