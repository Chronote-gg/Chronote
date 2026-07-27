import type { BillingInterval, PaidPlan, PaidTier } from "../../types/pricing";

export type PaidPlanLookup = Record<
  PaidTier,
  Partial<Record<BillingInterval, PaidPlan>>
>;

export const buildPaidPlanLookup = (plans: PaidPlan[]): PaidPlanLookup =>
  plans.reduce<PaidPlanLookup>(
    (acc, plan) => {
      acc[plan.tier] = acc[plan.tier] || {};
      acc[plan.tier][plan.interval] = plan;
      return acc;
    },
    { basic: {}, pro: {} },
  );

export const formatCurrency = (amountCents: number, currency: string) => {
  const normalized = currency.toUpperCase();
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: normalized,
    maximumFractionDigits: 0,
  }).format(amountCents / 100);
};

export const formatPlanPrice = (
  plan: PaidPlan | null,
  interval: BillingInterval,
) => {
  if (!plan) return "Pricing unavailable";
  const price = formatCurrency(plan.unitAmount, plan.currency);
  return `${price} / ${interval === "month" ? "mo" : "yr"}`;
};

export const billingLabelForInterval = (interval: BillingInterval) =>
  interval === "month" ? "Billed monthly" : "Billed yearly";

export const annualSavingsLabel = "2 months free";

export const resolvePaidPlan = (
  lookup: PaidPlanLookup,
  tier: PaidTier,
  interval: BillingInterval,
): PaidPlan | null => lookup[tier]?.[interval] ?? lookup[tier]?.month ?? null;
