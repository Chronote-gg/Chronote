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
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
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

export const resolvePaidPlan = (
  lookup: PaidPlanLookup,
  tier: PaidTier,
  interval: BillingInterval,
): PaidPlan | null => lookup[tier]?.[interval] ?? null;

export const getAnnualSavings = (lookup: PaidPlanLookup, tier: PaidTier) => {
  const monthly = resolvePaidPlan(lookup, tier, "month");
  const annual = resolvePaidPlan(lookup, tier, "year");
  if (
    !monthly ||
    !annual ||
    monthly.currency.toLowerCase() !== annual.currency.toLowerCase() ||
    !Number.isFinite(monthly.unitAmount) ||
    !Number.isFinite(annual.unitAmount) ||
    monthly.unitAmount <= 0 ||
    annual.unitAmount < 0
  )
    return null;
  const amount = monthly.unitAmount * 12 - annual.unitAmount;
  return amount > 0
    ? { amount, currency: annual.currency, months: amount / monthly.unitAmount }
    : null;
};
