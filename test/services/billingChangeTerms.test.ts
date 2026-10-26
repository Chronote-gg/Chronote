/** @jest-environment node */
import { billingChangeQuote } from "../../src/services/billingChangeTerms";
import { changeOperation, changePointer } from "../fixtures/billingChange";
import { sourceSubscription, fundedInvoice } from "../fixtures/renewalStripe";
it("shows the introductory first annual charge when scheduling a change", () => {
  const source = {
    source: changeOperation.source,
    saved: changePointer,
    subscription: sourceSubscription,
    invoice: fundedInvoice,
  };
  const target = {
    ...changeOperation.target,
    selection: {
      tier: "basic" as const,
      interval: "year" as const,
      expectedOffer: "basic_annual_intro_v1" as const,
    },
    unitAmount: 10000,
    offer: {
      id: "basic_annual_intro_v1" as const,
      authority: {
        guildId: changeOperation.guildId,
        mode: "test" as const,
        offerId: "basic_annual_intro_v1" as const,
        accountId: "acct-owned",
        coverageRevision: "coverage",
        boundaryRevision: "boundary",
        writerImageDigest: "sha256:" + "a".repeat(64),
      },
      terms: {
        interval: "year" as const,
        currency: "usd",
        priceId: "price_annual",
        couponId: "coupon_annual",
        regularUnitAmount: 10000,
        discountedUnitAmount: 6000,
        durationMonths: 12,
      },
    },
  };
  const quote = billingChangeQuote(source, target, "renewal");
  expect(quote.nextPlanRate).toBe(6000);
  expect(quote.offerTerms).toBe("$60 for your first year, then $100/year.");
  expect(billingChangeQuote(source, target, "immediate").nextPlanRate).toBe(
    10000,
  );
});
