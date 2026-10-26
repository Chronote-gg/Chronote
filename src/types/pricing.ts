import type {
  BasicIntroTerms,
  IntroOfferId,
  BASIC_ANNUAL_INTRO_TERMS,
} from "./basicIntroOffers";
export type PaidTier = "basic" | "pro";
export type BillingInterval = "month" | "year";

export type PaidPlan = {
  tier: PaidTier;
  interval: BillingInterval;
  priceId: string;
  unitAmount: number;
  currency: string;
  lookupKey?: string | null;
  productName?: string | null;
};
export type BasicIntroOffer =
  | { status: "inactive" | "ineligible" | "expired" | "unavailable" }
  | ({
      status: "available";
      priceId: string;
      enrollmentEndsAt: string | null;
      reservedForCheckout?: true;
    } & BasicIntroTerms);
export type ExpectedIntroOffer = "none" | IntroOfferId;
export type FirstYearPayment =
  | { status: "unavailable" }
  | {
      status: "available";
      currency: "usd";
      discountedSubtotal: (typeof BASIC_ANNUAL_INTRO_TERMS)["discountedUnitAmount"];
      amountPaid: number;
      periodStartsAt: string;
      periodEndsAt: string;
    };
export type IntroOfferChoice = "automatic" | "promotion";
export type SubscriptionPaymentProgress =
  "not_pending" | "processing" | "action_required" | "unavailable";
export type ProviderSubscriptionDetails =
  | { status: "unavailable" }
  | {
      status: "available";
      priceId: string;
      currency: string;
      unitAmount: number;
      discountedUnitAmount: number | null;
      interval: BillingInterval;
      renewalAt: string | null;
      cancelAtPeriodEnd: boolean;
      firstYearPayment: FirstYearPayment | null;
      paymentProgress?: SubscriptionPaymentProgress;
      discount: {
        percentOff: number | null;
        amountOff: number | null;
        durationMonths: number | null;
        endsAt: string | null;
        introductory: boolean;
      } | null;
      planChangesRestricted: boolean;
      planChangeRestrictionEndsAt: string | null;
    };
