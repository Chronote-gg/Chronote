import { describe, expect, test } from "@jest/globals";
import type { PaidPlan } from "../../src/types/pricing";
import {
  billingLabelForInterval,
  buildPaidPlanLookup,
  formatCurrency,
  formatPlanPrice,
  getAnnualSavings,
  resolvePaidPlan,
} from "../../src/frontend/utils/pricing";

describe("pricing utils", () => {
  const plans: PaidPlan[] = [
    {
      priceId: "basic-month",
      interval: "month",
      tier: "basic",
      unitAmount: 500,
      currency: "usd",
    },
    {
      priceId: "basic-year",
      interval: "year",
      tier: "basic",
      unitAmount: 5000,
      currency: "usd",
    },
  ];

  test("buildPaidPlanLookup groups plans by tier and interval", () => {
    const lookup = buildPaidPlanLookup(plans);
    expect(lookup.basic.month?.priceId).toBe("basic-month");
    expect(lookup.basic.year?.priceId).toBe("basic-year");
  });

  test("formatCurrency normalizes currency codes", () => {
    expect(formatCurrency(500, "usd")).toBe("$5");
    expect(formatCurrency(1234, "usd")).toBe("$12.34");
  });

  test("formatPlanPrice handles missing plan", () => {
    expect(formatPlanPrice(null, "month")).toBe("Pricing unavailable");
  });

  test("formatPlanPrice uses interval labels", () => {
    const lookup = buildPaidPlanLookup(plans);
    const plan = resolvePaidPlan(lookup, "basic", "month");
    expect(formatPlanPrice(plan, "month")).toBe("$5 / mo");
  });

  test("resolvePaidPlan requires an exact tier and interval", () => {
    const lookup = buildPaidPlanLookup(plans);
    const plan = resolvePaidPlan(lookup, "basic", "year");
    expect(plan?.priceId).toBe("basic-year");
    expect(
      resolvePaidPlan(buildPaidPlanLookup([plans[0]]), "basic", "year"),
    ).toBeNull();
    const fallback = resolvePaidPlan(lookup, "basic", "month");
    expect(fallback?.priceId).toBe("basic-month");
  });

  test("billing labels stay consistent", () => {
    expect(billingLabelForInterval("month")).toBe("Billed monthly");
    expect(billingLabelForInterval("year")).toBe("Billed yearly");
  });

  test("annual savings compare a full year in the same currency", () => {
    expect(getAnnualSavings(buildPaidPlanLookup(plans), "basic")).toEqual({
      amount: 1000,
      currency: "usd",
      months: 2,
    });
  });

  test.each([
    { label: "missing annual", prices: [plans[0]] },
    { label: "missing monthly", prices: [plans[1]] },
    {
      label: "different currencies",
      prices: [plans[0], { ...plans[1], currency: "eur" }],
    },
    {
      label: "same cost",
      prices: [plans[0], { ...plans[1], unitAmount: 6000 }],
    },
    {
      label: "annual costs more",
      prices: [plans[0], { ...plans[1], unitAmount: 7000 }],
    },
    {
      label: "zero monthly",
      prices: [{ ...plans[0], unitAmount: 0 }, plans[1]],
    },
    {
      label: "negative annual",
      prices: [plans[0], { ...plans[1], unitAmount: -100 }],
    },
    {
      label: "nonfinite amount",
      prices: [plans[0], { ...plans[1], unitAmount: NaN }],
    },
  ])("does not advertise savings for $label", ({ prices }) => {
    expect(getAnnualSavings(buildPaidPlanLookup(prices), "basic")).toBeNull();
  });
});
