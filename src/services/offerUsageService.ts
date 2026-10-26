import type { IntroOfferAuthority } from "../types/introOfferAuthority";
import { config } from "./configService";
import { HISTORY_WRITER_VERSION } from "../types/historyWriterBoundary";
import { BASIC_INTRO_OFFERS } from "../types/basicIntroOffers";
import type { StripeCheckoutSession } from "../types/stripe";
import { assertSessionAssociation } from "./purchaseSession";
import { randomUUID } from "node:crypto";
import type { PurchaseAttempt } from "../types/purchase";
import {
  introOfferIdSchema,
  offerUsageSchema,
  type OfferUsageMutation,
} from "../types/offerUsage";
import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import { BillingActionError } from "./billingActionError";

export async function prepareInitialOfferReservation(
  attempt: PurchaseAttempt,
  authority?: IntroOfferAuthority,
): Promise<OfferUsageMutation | undefined> {
  const parsed = introOfferIdSchema.safeParse(
    attempt.checkout.metadata?.intro_offer_id,
  );
  if (!parsed.success) return undefined;
  if (config.stripe.introOfferLedgerEnabled && !authority)
    throw new Error("Fresh offer requires verified history authority");
  const offerId = parsed.data;
  const priceId = attempt.checkout.line_items?.[0]?.price;
  const couponId = attempt.checkout.metadata?.intro_offer_coupon_id;
  if (
    !priceId ||
    !couponId ||
    attempt.checkout.discounts?.length !== 1 ||
    attempt.checkout.discounts[0].coupon !== couponId
  )
    throw new Error("Purchase offer terms are not frozen");
  const expected = await getOfferUsageRepository().get(
    attempt.guildId,
    offerId,
    attempt.mode,
  );
  if (expected && expected.state !== "unused")
    throw new BillingActionError(
      "BAD_REQUEST",
      "The selected offer is already used or reserved for this server.",
      expected.state === "used" ? "offer_changed_terms" : "purchase_pending",
    );
  const { interval, terms } = BASIC_INTRO_OFFERS[offerId];
  return {
    expected,
    authority,
    next: offerUsageSchema.parse({
      guildId: attempt.guildId,
      mode: attempt.mode,
      offerId,
      revision: randomUUID(),
      state: "reserved",
      writerVersion: HISTORY_WRITER_VERSION,
      operationId: attempt.attemptId,
      reservedAt: attempt.createdAt,
      terms: {
        interval,
        currency: terms.currency,
        regularUnitAmount: terms.regularUnitAmount,
        discountedUnitAmount: terms.discountedUnitAmount,
        durationMonths: terms.durationMonths,
        priceId,
        couponId,
      },
    }),
  };
}

export async function prepareExpiredOfferRelease(
  attempt: PurchaseAttempt,
  session: StripeCheckoutSession,
): Promise<OfferUsageMutation | undefined> {
  assertSessionAssociation(attempt, session);
  if (session.status !== "expired" || session.subscription)
    throw new Error("Purchase expiration is not verified");
  const parsed = introOfferIdSchema.safeParse(
    attempt.checkout.metadata?.intro_offer_id,
  );
  if (!parsed.success) return undefined;
  const expected = await getOfferUsageRepository().get(
    attempt.guildId,
    parsed.data,
    attempt.mode,
  );
  if (!expected) return undefined;
  if (
    expected.state !== "reserved" ||
    expected.operationId !== attempt.attemptId
  )
    throw new Error("Purchase offer reservation changed");
  return {
    expected,
    next: {
      guildId: attempt.guildId,
      mode: attempt.mode,
      offerId: parsed.data,
      revision: randomUUID(),
      state: "unused",
      released: {
        operationId: attempt.attemptId,
        reason: "checkout_expired",
        resourceId: session.id,
        verifiedAt: Date.now(),
      },
    },
  };
}
