import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import {
  BASIC_INTRO_OFFER_ID,
  BASIC_ANNUAL_INTRO_OFFER_ID,
  BASIC_INTRO_TERMS,
  BASIC_ANNUAL_INTRO_TERMS,
  type IntroOfferId,
} from "../types/basicIntroOffers";
import type { PurchaseAttempt } from "../types/purchase";
import type { BasicIntroOffer, BillingInterval } from "../types/pricing";
import { config } from "./configService";

export const introOfferIdFor = (interval: BillingInterval): IntroOfferId =>
  interval === "year" ? BASIC_ANNUAL_INTRO_OFFER_ID : BASIC_INTRO_OFFER_ID;

/** A live provider session with no incident: a newer request may supersede it. */
export const isSupersedableOpen = (
  attempt: PurchaseAttempt | undefined,
): attempt is PurchaseAttempt =>
  attempt?.state === "open" &&
  Boolean(attempt.sessionId) &&
  !attempt.incidentKey;

export async function ownsFrozenReservation(
  current: PurchaseAttempt,
  frozen: Extract<BasicIntroOffer, { status: "available" }>,
) {
  if (current.mode !== config.subscription.stripeMode) return false;
  const usage = await getOfferUsageRepository().get(
    current.guildId,
    frozen.id,
    current.mode,
  );
  if (usage?.state !== "reserved" || usage.operationId !== current.attemptId)
    return false;
  return (
    usage.terms.priceId === frozen.priceId &&
    usage.terms.couponId === current.checkout.metadata?.intro_offer_coupon_id &&
    usage.terms.interval ===
      (frozen.id === BASIC_ANNUAL_INTRO_OFFER_ID ? "year" : "month") &&
    usage.terms.currency === frozen.currency &&
    usage.terms.regularUnitAmount === frozen.regularUnitAmount &&
    usage.terms.discountedUnitAmount === frozen.discountedUnitAmount &&
    usage.terms.durationMonths === frozen.durationMonths
  );
}

export function frozenIntroOffer(
  current: PurchaseAttempt | undefined,
): BasicIntroOffer | null {
  const id = current?.checkout.metadata?.intro_offer_id;
  if (
    !current ||
    (id !== BASIC_INTRO_OFFER_ID && id !== BASIC_ANNUAL_INTRO_OFFER_ID)
  )
    return null;
  const priceId = current.checkout.line_items?.[0]?.price;
  const enrollmentEndsAt =
    current.checkout.metadata?.intro_offer_enrollment_ends_at;
  if (!priceId) return null;
  return {
    status: "available",
    reservedForCheckout: true,
    ...(id === BASIC_ANNUAL_INTRO_OFFER_ID
      ? BASIC_ANNUAL_INTRO_TERMS
      : BASIC_INTRO_TERMS),
    priceId,
    enrollmentEndsAt: enrollmentEndsAt ? String(enrollmentEndsAt) : null,
  };
}

export function canReuseFrozenIntroOffer(
  frozen: BasicIntroOffer | null,
  current: PurchaseAttempt,
  interval: BillingInterval,
  payerId: string | undefined,
): frozen is Extract<BasicIntroOffer, { status: "available" }> {
  return Boolean(
    frozen?.status === "available" &&
    frozen.id === introOfferIdFor(interval) &&
    payerId === current.payerId &&
    !current.incidentKey &&
    (current.state === "open" ||
      (current.state === "preparing" &&
        Date.now() - current.createdAt < 29 * 60 * 1000)) &&
    Number(current.checkout.expires_at) * 1000 > Date.now(),
  );
}

/** An open attempt without an incident is supersedable, so it only answers for its own payer; `null` means quote the ledger. */
export async function attemptIntroOffer(
  current: PurchaseAttempt,
  params: { payerId?: string; interval?: BillingInterval },
): Promise<BasicIntroOffer | null> {
  const blocking =
    current.state === "preparing" ||
    current.state === "needs_review" ||
    (current.state === "open" && Boolean(current.incidentKey));
  if (!blocking && current.state !== "open") return null;
  const frozen = frozenIntroOffer(current);
  if (
    canReuseFrozenIntroOffer(
      frozen,
      current,
      params.interval ?? "month",
      params.payerId,
    ) &&
    (await ownsFrozenReservation(current, frozen))
  )
    return frozen;
  return blocking ? { status: "unavailable" } : null;
}

/**
 * The id of a supersedable open attempt holding `offerId`'s reservation. A
 * quote judges that reservation as released, so coverage must still resolve.
 */
export async function openAttemptHoldingOffer(
  current: PurchaseAttempt | undefined,
  offerId: IntroOfferId,
): Promise<string | undefined> {
  if (!isSupersedableOpen(current)) return undefined;
  const frozen = frozenIntroOffer(current);
  return frozen?.status === "available" &&
    frozen.id === offerId &&
    (await ownsFrozenReservation(current, frozen))
    ? current.attemptId
    : undefined;
}
