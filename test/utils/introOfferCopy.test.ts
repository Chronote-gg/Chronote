import { formatIntroOfferTerms } from "../../src/utils/introOfferCopy";
it("uses the frozen annual amounts for its reviewed disclosure", () => {
  expect(
    formatIntroOfferTerms({
      interval: "year",
      currency: "usd",
      discountedUnitAmount: 9000,
      regularUnitAmount: 15000,
      durationMonths: 12,
    }),
  ).toBe("$90 for your first year, then $150/year.");
});
it("uses the frozen monthly duration and fractional amounts", () => {
  expect(
    formatIntroOfferTerms({
      interval: "month",
      currency: "usd",
      discountedUnitAmount: 750,
      regularUnitAmount: 1250,
      durationMonths: 6,
    }),
  ).toBe("$7.50/month for your first 6 months, then $12.50/month.");
});
