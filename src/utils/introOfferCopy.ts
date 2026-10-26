import type { BillingInterval } from "../types/pricing";
type DisplayTerms = {
  interval: BillingInterval;
  currency: string;
  discountedUnitAmount: number;
  regularUnitAmount: number;
  durationMonths: number;
};
export function formatIntroOfferTerms(terms: DisplayTerms): string {
  const money = (amount: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: terms.currency.toUpperCase(),
      minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount / 100);
  const discounted = money(terms.discountedUnitAmount);
  const regular = money(terms.regularUnitAmount);
  const duration =
    terms.durationMonths === 12 ? "year" : `${terms.durationMonths} months`;
  if (terms.interval === "year")
    return `${discounted} for your first ${duration}, then ${regular}/year.`;
  return `${discounted}/month for your first ${terms.durationMonths} months, then ${regular}/month.`;
}
