/** @jest-environment node */
import Stripe from "stripe";
import { readSubscriptionPaymentProgress } from "../../src/services/subscriptionPaymentProgress";
const subscription = {
  id: "sub-owned",
  status: "incomplete" as const,
  customer: "cus-owned",
  latest_invoice: "in-owned",
  livemode: false,
};
function fixture() {
  const stripe = new Stripe("sk_test_unused");
  const invoice = {
    id: "in-owned",
    customer: "cus-owned",
    livemode: false,
    status: "open",
    currency: "usd",
    amount_remaining: 600,
    parent: { subscription_details: { subscription: "sub-owned" } },
  };
  const intent = {
    id: "pi-owned",
    customer: "cus-owned",
    livemode: false,
    currency: "usd",
    amount: 600,
    status: "processing",
  };
  const payment = {
    id: "ip-owned",
    invoice: "in-owned",
    livemode: false,
    currency: "usd",
    status: "open",
    is_default: true,
    amount_requested: 600,
    payment: { type: "payment_intent", payment_intent: intent },
  };
  const read = jest
    .spyOn(stripe.invoices, "retrieve")
    .mockResolvedValue(invoice as never);
  const list = jest
    .spyOn(stripe.invoicePayments, "list")
    .mockResolvedValue({ data: [payment], has_more: false } as never);
  return { stripe, invoice, intent, payment, read, list };
}
afterEach(() => jest.restoreAllMocks());
test("only native processing payment receives the settling state", async () => {
  const f = fixture();
  expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
    "processing",
  );
});
test.each([
  "requires_action",
  "requires_payment_method",
  "requires_confirmation",
])("%s requires a check/payment action, not waiting", async (status) => {
  const f = fixture();
  f.intent.status = status;
  expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
    "action_required",
  );
});
test("active subscriptions with an introductory discount are not payment-pending", async () => {
  const f = fixture();
  expect(
    await readSubscriptionPaymentProgress(f.stripe, {
      ...subscription,
      status: "active",
    }),
  ).toBe("not_pending");
  expect(f.read).not.toHaveBeenCalled();
});
test.each(["id", "customer", "livemode"] as const)(
  "wrong invoice %s association cannot imply settling",
  async (key) => {
    const f = fixture();
    Reflect.set(f.invoice, key, key === "livemode" ? true : "wrong");
    expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
      "unavailable",
    );
    expect(f.list).not.toHaveBeenCalled();
  },
);
test("another subscription's invoice cannot imply settling", async () => {
  const f = fixture();
  f.invoice.parent.subscription_details.subscription = "another";
  expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
    "unavailable",
  );
});
test("a truncated or competing payment list cannot imply a single processing payment", async () => {
  const f = fixture();
  f.list
    .mockResolvedValueOnce({ data: [f.payment], has_more: true } as never)
    .mockResolvedValueOnce({
      data: [f.payment, { ...f.payment, id: "another" }],
      has_more: false,
    } as never);
  expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
    "unavailable",
  );
  expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
    "unavailable",
  );
});
test.each(["customer", "currency", "livemode", "amount"] as const)(
  "wrong PaymentIntent %s cannot imply settling",
  async (key) => {
    const f = fixture();
    Reflect.set(
      f.intent,
      key,
      key === "amount" ? 1 : key === "livemode" ? true : "wrong",
    );
    expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
      "unavailable",
    );
  },
);
test("provider read failures remain unknown instead of claiming processing", async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error("unavailable"));
  expect(await readSubscriptionPaymentProgress(f.stripe, subscription)).toBe(
    "unavailable",
  );
});
