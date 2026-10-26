import type {
  BasicIntroOffer,
  PaidPlan,
  ProviderSubscriptionDetails,
} from "../../types/pricing";

export const introPlans: PaidPlan[] = [
  {
    tier: "basic",
    interval: "month",
    priceId: "basic",
    unitAmount: 1000,
    currency: "usd",
  },
  {
    tier: "basic",
    interval: "year",
    priceId: "basic-year",
    unitAmount: 10000,
    currency: "usd",
  },
  {
    tier: "pro",
    interval: "month",
    priceId: "pro",
    unitAmount: 2400,
    currency: "usd",
  },
  {
    tier: "pro",
    interval: "year",
    priceId: "pro-year",
    unitAmount: 24000,
    currency: "usd",
  },
];
export const monthlyIntroOffer: BasicIntroOffer = {
  status: "available",
  id: "basic_intro_v1",
  priceId: "basic",
  currency: "usd",
  percentOff: 40,
  enrollmentEndsAt: null,
  regularUnitAmount: 1000,
  discountedUnitAmount: 600,
  durationMonths: 3,
};
export const annualIntroOffer: BasicIntroOffer = {
  status: "available",
  id: "basic_annual_intro_v1",
  priceId: "basic-year",
  currency: "usd",
  percentOff: 40,
  enrollmentEndsAt: null,
  regularUnitAmount: 10000,
  discountedUnitAmount: 6000,
  durationMonths: 12,
};
export const monthlySubscriber: Extract<
  ProviderSubscriptionDetails,
  { status: "available" }
> = {
  status: "available",
  priceId: "basic",
  currency: "usd",
  unitAmount: 1000,
  discountedUnitAmount: 600,
  interval: "month",
  renewalAt: "2026-11-12T12:00:00Z",
  cancelAtPeriodEnd: false,
  firstYearPayment: null,
  discount: {
    percentOff: 40,
    amountOff: null,
    durationMonths: 3,
    endsAt: "2027-01-12T12:00:00Z",
    introductory: true,
  },
  planChangesRestricted: false,
  planChangeRestrictionEndsAt: null,
};
export const annualSubscriber: Extract<
  ProviderSubscriptionDetails,
  { status: "available" }
> = {
  status: "available",
  priceId: "basic-year",
  currency: "usd",
  unitAmount: 10000,
  discountedUnitAmount: null,
  interval: "year",
  renewalAt: "2027-10-12T12:00:00Z",
  cancelAtPeriodEnd: false,
  firstYearPayment: {
    status: "available",
    currency: "usd",
    discountedSubtotal: 6000,
    amountPaid: 6420,
    periodStartsAt: "2026-10-12T12:00:00Z",
    periodEndsAt: "2027-10-12T12:00:00Z",
  },
  discount: null,
  planChangesRestricted: false,
  planChangeRestrictionEndsAt: null,
};
