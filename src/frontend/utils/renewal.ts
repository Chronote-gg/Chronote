import type { RenewalTerms } from "../../types/renewal";
import { formatCurrency } from "./pricing";
export const renewalDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
export const renewalTierName = (tier: RenewalTerms["tier"]) =>
  tier === "basic" ? "Basic" : "Pro";
export function renewalRate(terms: RenewalTerms) {
  return (
    formatCurrency(terms.unitAmount, terms.currency) +
    "/" +
    terms.interval +
    (terms.taxBehavior === "inclusive" ? ", tax included" : " before tax")
  );
}
