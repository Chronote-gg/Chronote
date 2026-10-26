export function historicalMonthlyInvoiceFixture() {
  const price = {
    id: "price",
    product: "prod",
    livemode: false,
    currency: "usd",
    type: "recurring",
    billing_scheme: "per_unit",
    transform_quantity: null,
    unit_amount: 1000,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
  const coupon = {
    id: "coupon",
    livemode: false,
    percent_off: 40,
    amount_off: null,
    currency: null,
    duration: "repeating",
    duration_in_months: 3,
    valid: false,
    applies_to: { products: ["prod"] },
  };
  const invoice = {
    id: "in-first",
    customer: "cus",
    created: 500,
    status: "paid",
    livemode: false,
    currency: "usd",
    billing_reason: "subscription_create",
    subtotal: 1000,
    amount_paid: 600,
    amount_remaining: 0,
    status_transitions: { paid_at: 501, voided_at: null as number | null },
    parent: {
      subscription_details: {
        subscription: "sub",
        metadata: {
          guild_id: "111111111111111111",
          discord_id: "payer",
          purchase_attempt_id: "original",
          intro_offer_id: "basic_intro_v1",
          intro_offer_coupon_id: "coupon",
        },
      },
    },
    discounts: [{ id: "di", source: { type: "coupon", coupon } }],
    total_discount_amounts: [{ amount: 400, discount: "di" }],
    lines: {
      has_more: false,
      data: [
        {
          id: "line",
          invoice: "in-first",
          livemode: false,
          currency: "usd",
          quantity: 1,
          amount: 1000,
          pricing: { price_details: { price: "price" } },
          parent: {
            subscription_item_details: {
              subscription: "sub",
              subscription_item: "item",
              proration: false,
            },
          },
          period: { start: 500, end: 600 },
          discount_amounts: [{ amount: 400, discount: "di" }],
        },
      ],
    },
  };
  return { price, coupon, invoice };
}
