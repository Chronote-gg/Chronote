import type {
  BasicIntroOffer,
  BillingInterval,
  PaidPlan,
  PaidTier,
} from "../../types/pricing";

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
    minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
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

export const resolveIntroOffer = (
  offer: BasicIntroOffer | undefined,
  plan: PaidPlan | null,
): BasicIntroOffer => {
  if (!offer) return { status: "inactive" };
  if (offer.status !== "available") return offer;
  if (
    !plan ||
    offer.priceId !== plan.priceId ||
    offer.regularUnitAmount !== plan.unitAmount ||
    offer.currency !== plan.currency ||
    (offer.id === "basic_intro_v1" ? "month" : "year") !== plan.interval
  )
    return { status: "unavailable" };
  return offer;
};

export const introOfferTerms = (
  offer: Extract<BasicIntroOffer, { status: "available" }>,
) => {
  const discounted = formatCurrency(offer.discountedUnitAmount, offer.currency);
  const regular = formatCurrency(offer.regularUnitAmount, offer.currency);
  return offer.id === "basic_intro_v1"
    ? `${discounted}/month for your first ${offer.durationMonths} months, then ${regular}/month`
    : `${discounted} for your first year, then ${regular}/year`;
};

export const introOfferPrice = (
  offer: BasicIntroOffer,
  plan: PaidPlan | null,
  interval: BillingInterval,
) =>
  offer.status === "available"
    ? `${formatCurrency(offer.discountedUnitAmount, offer.currency)} / ${interval === "year" ? "yr" : "mo"}`
    : formatPlanPrice(plan, interval);

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
