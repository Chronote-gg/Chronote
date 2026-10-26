import { z } from "zod";

export const BASIC_INTRO_OFFER_ID = "basic_intro_v1";
export const BASIC_ANNUAL_INTRO_OFFER_ID = "basic_annual_intro_v1";

// Preserve these v1 terms when validating existing reservations and use records.
export const BASIC_INTRO_TERMS = Object.freeze({
  id: BASIC_INTRO_OFFER_ID,
  currency: "usd",
  regularUnitAmount: 1000,
  discountedUnitAmount: 600,
  percentOff: 40,
  durationMonths: 3,
} as const);
export const BASIC_ANNUAL_INTRO_TERMS = Object.freeze({
  id: BASIC_ANNUAL_INTRO_OFFER_ID,
  currency: "usd",
  regularUnitAmount: 10000,
  discountedUnitAmount: 6000,
  percentOff: 40,
  durationMonths: 12,
} as const);

export const introOfferIdSchema = z.enum([
  BASIC_INTRO_OFFER_ID,
  BASIC_ANNUAL_INTRO_OFFER_ID,
]);
export type IntroOfferId = z.infer<typeof introOfferIdSchema>;
type IntroTerms<T> = { -readonly [Key in keyof T]: T[Key] };
export type BasicIntroTerms =
  | IntroTerms<typeof BASIC_INTRO_TERMS>
  | IntroTerms<typeof BASIC_ANNUAL_INTRO_TERMS>;
export const BASIC_INTRO_OFFERS = Object.freeze({
  [BASIC_INTRO_OFFER_ID]: Object.freeze({
    interval: "month" as const,
    terms: BASIC_INTRO_TERMS,
  }),
  [BASIC_ANNUAL_INTRO_OFFER_ID]: Object.freeze({
    interval: "year" as const,
    terms: BASIC_ANNUAL_INTRO_TERMS,
  }),
});
