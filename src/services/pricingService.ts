import { config } from "./configService";
import type { BillingInterval, PaidPlan, PaidTier } from "../types/pricing";
import type { StripeClient, StripePrice } from "../types/stripe";

type LookupConfig = {
  key: string;
  tier: PaidTier;
  interval: BillingInterval;
};

const buildLookupConfigs = (): LookupConfig[] => {
  const lookup = config.stripe.lookupKeys;
  const configs: LookupConfig[] = [
    { key: lookup.basicMonthly, tier: "basic", interval: "month" },
    { key: lookup.basicAnnual, tier: "basic", interval: "year" },
    { key: lookup.proMonthly, tier: "pro", interval: "month" },
    { key: lookup.proAnnual, tier: "pro", interval: "year" },
  ];
  return configs.filter((entry) => entry.key);
};

const lookupByKey = (configs: LookupConfig[]) =>
  new Map(configs.map((entry) => [entry.key, entry]));

const parseUnitAmount = (price: StripePrice) => {
  if (typeof price.unit_amount === "number") return price.unit_amount;
  if (price.unit_amount_decimal) {
    const parsed = Number(price.unit_amount_decimal);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const sortPlans = (plans: PaidPlan[]) => {
  const tierOrder: Record<PaidTier, number> = { basic: 0, pro: 1 };
  const intervalOrder: Record<BillingInterval, number> = {
    month: 0,
    year: 1,
  };
  return [...plans].sort((a, b) => {
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return intervalOrder[a.interval] - intervalOrder[b.interval];
  });
};

export async function getPaidPlans(stripe: StripeClient): Promise<PaidPlan[]> {
  const lookupConfigs = buildLookupConfigs();
  const lookupKeys = lookupConfigs.map((entry) => entry.key);
  if (lookupKeys.length === 0) {
    return [];
  }
  const priceList = await stripe.prices.list({
    lookup_keys: lookupKeys,
    active: true,
    limit: 100,
    expand: ["data.product"],
  });
  const lookupMap = lookupByKey(lookupConfigs);
  const plans = priceList.data
    .map((price) => {
      const lookupKey = price.lookup_key ?? "";
      const lookup = lookupMap.get(lookupKey);
      if (!lookup) {
        return null;
      }
      const unitAmount = parseUnitAmount(price);
      if (unitAmount === null) {
        return null;
      }
      const product = typeof price.product === "string" ? null : price.product;
      const productName = product && "name" in product ? product.name : null;
      const plan: PaidPlan = {
        tier: lookup.tier,
        interval: lookup.interval,
        priceId: price.id,
        unitAmount,
        currency: price.currency,
        lookupKey,
        productName,
      };
      return plan;
    })
    .filter((plan): plan is PaidPlan => Boolean(plan));

  return sortPlans(plans);
}

export function resolveTierFromLookupKey(
  lookupKey: string | null | undefined,
): PaidTier | null {
  if (!lookupKey) return null;
  const lookup = config.stripe.lookupKeys;
  const tierByKey: Record<string, PaidTier> = {
    [lookup.basicMonthly]: "basic",
    [lookup.basicAnnual]: "basic",
    [lookup.proMonthly]: "pro",
    [lookup.proAnnual]: "pro",
  };
  return tierByKey[lookupKey] ?? null;
}

export function resolveTierFromPrice(params: {
  priceId?: string | null;
  lookupKey?: string | null;
}): PaidTier | null {
  const lookupTier = resolveTierFromLookupKey(params.lookupKey);
  if (lookupTier) return lookupTier;
  if (
    params.priceId &&
    config.stripe.priceBasic &&
    params.priceId === config.stripe.priceBasic
  ) {
    return "basic";
  }
  return null;
}

export function getMockPaidPlans(): PaidPlan[] {
  const lookupConfigs = buildLookupConfigs();
  const lookupMap = lookupByKey(lookupConfigs);
  const planFor = (tier: PaidTier, interval: BillingInterval, amount: number) =>
    ({
      tier,
      interval,
      priceId: `price_mock_${tier}_${interval}`,
      unitAmount: amount,
      currency: "usd",
      lookupKey:
        [...lookupMap.values()].find(
          (entry) => entry.tier === tier && entry.interval === interval,
        )?.key ?? null,
      productName: `${tier === "basic" ? "Basic" : "Pro"} (${interval})`,
    }) satisfies PaidPlan;

  return sortPlans([
    planFor("basic", "month", 1200),
    planFor("basic", "year", 12000),
    planFor("pro", "month", 2900),
    planFor("pro", "year", 29000),
  ]);
}

export async function resolvePaidPlanPriceId(params: {
  stripe: StripeClient;
  tier: PaidTier;
  interval: BillingInterval;
}): Promise<string | null> {
  const plans = await getPaidPlans(params.stripe);
  return (
    plans.find(
      (plan) => plan.tier === params.tier && plan.interval === params.interval,
    )?.priceId ?? null
  );
}
