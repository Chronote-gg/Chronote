import {
  introOfferAuthoritySchema,
  type IntroOfferAuthority,
} from "./introOfferAuthority";
import { ledgerWriterRuntimeSchema } from "./ledgerWriterRuntime";
import { HISTORY_WRITER_VERSION } from "./historyWriterBoundary";
import type { IntroOfferId } from "./basicIntroOffers";
import {
  BASIC_INTRO_OFFER_ID,
  BASIC_INTRO_TERMS,
  BASIC_ANNUAL_INTRO_TERMS,
  introOfferIdSchema,
} from "./basicIntroOffers";
export { introOfferIdSchema, type IntroOfferId } from "./basicIntroOffers";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { PurchaseAttempt } from "./purchase";
import type { GuildSubscription } from "./db";

export const providerModeSchema = z.enum(["live", "test"]);
export type ProviderMode = z.infer<typeof providerModeSchema>;
const nonempty = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const termsBase = z.object({
  priceId: nonempty,
  couponId: nonempty,
  currency: z.literal(BASIC_INTRO_TERMS.currency),
});
export const offerTermsSchema = z.discriminatedUnion("interval", [
  termsBase
    .extend({
      interval: z.literal("month"),
      regularUnitAmount: z.literal(BASIC_INTRO_TERMS.regularUnitAmount),
      discountedUnitAmount: z.literal(BASIC_INTRO_TERMS.discountedUnitAmount),
      durationMonths: z.literal(BASIC_INTRO_TERMS.durationMonths),
    })
    .strict(),
  termsBase
    .extend({
      interval: z.literal("year"),
      regularUnitAmount: z.literal(BASIC_ANNUAL_INTRO_TERMS.regularUnitAmount),
      discountedUnitAmount: z.literal(
        BASIC_ANNUAL_INTRO_TERMS.discountedUnitAmount,
      ),
      durationMonths: z.literal(BASIC_ANNUAL_INTRO_TERMS.durationMonths),
    })
    .strict(),
]);
const base = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  mode: providerModeSchema,
  offerId: introOfferIdSchema,
  revision: nonempty,
});
const reserved = base.extend({
  state: z.literal("reserved"),
  operationId: nonempty,
  reservedAt: timestamp,
  writerVersion: z.literal(HISTORY_WRITER_VERSION).optional(),
  writerRuntime: ledgerWriterRuntimeSchema.optional(),
  terms: offerTermsSchema,
});
export const offerUsageSchema = z.discriminatedUnion("state", [
  reserved.strict(),
  reserved
    .extend({
      state: z.literal("used"),
      usedAt: timestamp,
      settlement: z
        .object({
          customerId: nonempty,
          subscriptionId: nonempty,
          subscriptionItemId: nonempty,
          invoiceId: nonempty,
          priceId: nonempty,
          status: z.literal("paid"),
          amountPaid: z.number().int().nonnegative(),
          amountRemaining: z.literal(0),
          settledAt: timestamp,
        })
        .strict(),
    })
    .strict(),
  base
    .extend({
      state: z.literal("unused"),
      released: z
        .object({
          operationId: nonempty,
          reason: z.enum([
            "checkout_expired",
            "initial_invoice_voided",
            "change_canceled",
            "schedule_canceled",
          ]),
          resourceId: nonempty,
          verifiedAt: timestamp,
        })
        .strict(),
    })
    .strict(),
]);
export type OfferUsage = z.infer<typeof offerUsageSchema>;
export type OfferUsageWrite = {
  next: unknown;
  expected: unknown;
  pointer: GuildSubscription | undefined;
  operation: PurchaseAttempt;
  authority?: IntroOfferAuthority;
};
export function offerUsageKey(
  guildId: string,
  offerId: IntroOfferId,
  mode: ProviderMode,
): string {
  const scope = base
    .pick({ guildId: true, offerId: true, mode: true })
    .parse({ guildId, offerId, mode });
  return `OFFER#${scope.mode}#${scope.guildId}#${scope.offerId}`;
}
export type OfferUsageMutation = Pick<
  OfferUsageWrite,
  "next" | "expected" | "authority"
>;
export function parseOfferUsageChange(input: OfferUsageWrite) {
  const next = offerUsageSchema.parse(input.next);
  const expected =
    input.expected === undefined
      ? undefined
      : offerUsageSchema.parse(input.expected);
  assertOperationScope(next, input);
  assertUsageTransition(next, expected);
  assertSettlement(next, expected);
  const authority =
    input.authority && introOfferAuthoritySchema.parse(input.authority);
  if (
    authority &&
    (next.state !== "reserved" ||
      authority.guildId !== next.guildId ||
      authority.mode !== next.mode ||
      authority.offerId !== next.offerId)
  )
    throw new Error("Offer authority scope mismatch");
  return { next, expected, authority };
}
function owner(next: OfferUsage): string {
  return next.state === "unused" ? next.released.operationId : next.operationId;
}
function assertOperationScope(next: OfferUsage, input: OfferUsageWrite) {
  if (
    next.guildId !== input.operation.guildId ||
    next.mode !== input.operation.mode ||
    owner(next) !== input.operation.attemptId ||
    input.operation.incidentKey ||
    input.operation.state === "needs_review" ||
    (input.pointer && input.pointer.guildId !== next.guildId)
  )
    throw new Error("Offer operation scope mismatch");
}
export function assertUsageTransition(
  next: OfferUsage,
  expected: OfferUsage | undefined,
) {
  if (
    expected &&
    (offerUsageKey(expected.guildId, expected.offerId, expected.mode) !==
      offerUsageKey(next.guildId, next.offerId, next.mode) ||
      next.revision === expected.revision)
  )
    throw new Error("Invalid offer usage transition");
  if (!expected || expected.state === "unused") {
    if (next.state !== "reserved")
      throw new Error("Invalid offer usage transition");
  } else if (
    expected.state === "used" ||
    expected.operationId !== owner(next) ||
    (next.state !== "used" && next.state !== "unused")
  ) {
    throw new Error("Invalid offer usage transition");
  }
}
export function assertSettlement(
  next: OfferUsage,
  expected: OfferUsage | undefined,
) {
  if (next.state === "unused") return;
  if (
    next.terms.interval !==
    (next.offerId === BASIC_INTRO_OFFER_ID ? "month" : "year")
  )
    throw new Error("Offer terms do not match its identity");
  if (
    next.state === "used" &&
    (expected?.state !== "reserved" ||
      !isDeepStrictEqual(next.terms, expected.terms) ||
      next.settlement.priceId !== next.terms.priceId ||
      next.reservedAt !== expected.reservedAt ||
      next.usedAt < next.reservedAt ||
      next.settlement.settledAt < Math.floor(next.reservedAt / 1000) * 1000)
  )
    throw new Error("Invalid offer settlement");
}
