import { config } from "../../src/services/configService";

export function basicMonthlyTestPrice() {
  return {
    id: "price_basic",
    active: true,
    livemode: false,
    currency: "usd",
    unit_amount: 1000,
    lookup_key: config.stripe.lookupKeys.basicMonthly,
    billing_scheme: "per_unit",
    type: "recurring",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    product: "prod_basic",
  };
}
