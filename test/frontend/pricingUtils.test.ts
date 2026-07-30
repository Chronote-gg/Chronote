import { describe, expect, test } from "@jest/globals";
import type { PaidPlan } from "../../src/types/pricing";
import {
  annualSavingsLabel,
  billingLabelForInterval,
  buildPaidPlanLookup,
  formatCurrency,
  formatPlanPrice,
  resolvePaidPlan,
} from "../../src/frontend/utils/pricing";

describe("pricing utils", () => {
  const plans: PaidPlan[] = [
    {
      id: "basic-month",
      interval: "month",
      tier: "basic",
      unitAmount: 500,
      currency: "usd",
    },
    {
      id: "basic-year",
      interval: "year",
      tier: "basic",
      unitAmount: 5000,
      currency: "usd",
    },
  ];

  test("buildPaidPlanLookup groups plans by tier and interval", () => {
    const lookup = buildPaidPlanLookup(plans);
    expect(lookup.basic.month?.id).toBe("basic-month");
    expect(lookup.basic.year?.id).toBe("basic-year");
  });

  test("formatCurrency normalizes currency codes", () => {
    expect(formatCurrency(500, "usd")).toBe("$5");
  });

  test("formatPlanPrice handles missing plan", () => {
    expect(formatPlanPrice(null, "month")).toBe("Pricing unavailable");
  });

  test("formatPlanPrice uses interval labels", () => {
    const lookup = buildPaidPlanLookup(plans);
    const plan = resolvePaidPlan(lookup, "basic", "month");
    expect(formatPlanPrice(plan, "month")).toBe("$5 / mo");
  });

  test("resolvePaidPlan falls back to monthly plan", () => {
    const lookup = buildPaidPlanLookup(plans);
    const plan = resolvePaidPlan(lookup, "basic", "year");
    expect(plan?.id).toBe("basic-year");
    const fallback = resolvePaidPlan(lookup, "basic", "month");
    expect(fallback?.id).toBe("basic-month");
  });

  test("billing labels stay consistent", () => {
    expect(billingLabelForInterval("month")).toBe("Billed monthly");
    expect(billingLabelForInterval("year")).toBe("Billed yearly");
    expect(annualSavingsLabel).toBe("2 months free");
  });
});
