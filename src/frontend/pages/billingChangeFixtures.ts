import type {
  BillingChangeSelection,
  BillingChangeView,
} from "../../types/billingChange";
export function previewChangeReview(
  selection: BillingChangeSelection,
): Extract<BillingChangeView, { kind: "operation" }> {
  const scheduled =
    selection.tier === "free" ||
    (selection.tier === "basic" && selection.interval === "month");
  const annual = selection.interval === "year";
  const regular = {
    free: { month: 0, year: 0 },
    basic: { month: 1000, year: 10000 },
    pro: { month: 2400, year: 24000 },
  }[selection.tier][selection.interval];
  const planCharge = scheduled || annual ? regular : 1200;
  const savings =
    selection.expectedOffer === "basic_annual_intro_v1"
      ? 4000
      : selection.expectedOffer === "basic_intro_v1"
        ? 400
        : 0;
  return {
    kind: "operation",
    state: "review",
    operationId: "00000000-0000-4000-8000-000000000001",
    revision: "review",
    paymentUrl: null,
    quote: {
      targetTier: selection.tier,
      interval: selection.interval,
      timing: scheduled ? "renewal" : "immediate",
      effectiveAt: "2026-11-12T12:00:00Z",
      currency: "usd",
      chargeLabel: annual
        ? "Basic for one year"
        : "Pro for the rest of this month",
      chargePeriod: null,
      creditLabel: "Unused paid Basic time",
      planCharge,
      offerSavings: savings,
      unusedCredit: scheduled ? 0 : 300,
      taxAmount: 0,
      taxTreatment: "included",
      billingBalance: 0,
      balanceCarriedForward: 0,
      amountDue: scheduled ? 0 : planCharge - savings - 300,
      remainingCredit: 0,
      nextPlanRate:
        selection.expectedOffer === "basic_intro_v1" ? 600 : regular,
      nextAt: annual ? "2027-10-15T12:00:00Z" : "2026-11-12T12:00:00Z",
      offerTerms: {
        none: null,
        basic_intro_v1: "$6/month for three months, then $10/month.",
        basic_annual_intro_v1: "$60 for your first year, then $100/year.",
      }[selection.expectedOffer],
      endingOffer: selection.tier === "pro" ? "monthly" : null,
    },
  };
}
