import { config } from "./configService";
import { getBasicIntroOffer } from "./basicIntroOfferService";
import { getPaidPlans, getMockPaidPlans } from "./pricingService";
import type { StripeClient } from "../types/stripe";
import type { BasicIntroOffer, PaidPlan } from "../types/pricing";

type PublicPricing = {
  plans: PaidPlan[];
  introOffer: BasicIntroOffer;
  annualIntroOffer: BasicIntroOffer;
};
type CachedPricing = {
  key: string;
  expiresAt: number;
  result: Promise<PublicPricing>;
};
// Client identity stays in process. Each client retains only its latest configuration.
const snapshots = new WeakMap<StripeClient, CachedPricing>();
const VERIFIED_TTL_MS = 30_000;
const UNAVAILABLE_TTL_MS = 1_000;

function configurationKey(): string {
  return JSON.stringify({
    mode: config.subscription.stripeMode,
    lookup: config.stripe.lookupKeys,
    offer: config.stripe.basicIntroOffer,
    ledgerEnabled: config.stripe.introOfferLedgerEnabled,
  });
}
function expiresAt(snapshot: PublicPricing): number {
  const now = Date.now();
  const unavailable =
    snapshot.introOffer.status === "unavailable" ||
    snapshot.annualIntroOffer.status === "unavailable";
  const ttl = now + (unavailable ? UNAVAILABLE_TTL_MS : VERIFIED_TTL_MS);
  const boundaries = [
    config.stripe.basicIntroOffer.startsAt,
    config.stripe.basicIntroOffer.enrollmentEndsAt,
  ]
    .map((value) => Date.parse(value))
    .filter((value) => value > now);
  const offerEnds = [snapshot.introOffer, snapshot.annualIntroOffer].flatMap(
    (offer) =>
      offer.status === "available" && offer.enrollmentEndsAt !== null
        ? [Date.parse(offer.enrollmentEndsAt)]
        : [],
  );
  return Math.min(ttl, ...boundaries, ...offerEnds);
}
async function verifyPublicPricing(
  stripe: StripeClient,
): Promise<PublicPricing> {
  const plans = await getPaidPlans(stripe);
  const [introOffer, annualIntroOffer] = await Promise.all([
    getBasicIntroOffer({ stripe, plans }),
    getBasicIntroOffer({ stripe, plans, interval: "year" }),
  ]);
  return {
    plans: plans.length ? plans : getMockPaidPlans(),
    introOffer,
    annualIntroOffer,
  };
}
function currentOfferTime(
  offer: BasicIntroOffer,
  now: number,
): BasicIntroOffer {
  if (
    offer.status === "available" &&
    offer.enrollmentEndsAt !== null &&
    now >= Date.parse(offer.enrollmentEndsAt)
  )
    return { status: "expired" };
  return offer;
}
async function completeSnapshot(
  stripe: StripeClient,
  snapshot: PublicPricing,
  startedAt: number,
): Promise<PublicPricing> {
  const start = Date.parse(config.stripe.basicIntroOffer.startsAt);
  if (startedAt < start && Date.now() >= start)
    snapshot = await verifyPublicPricing(stripe);
  const now = Date.now();
  return {
    ...snapshot,
    introOffer: currentOfferTime(snapshot.introOffer, now),
    annualIntroOffer: currentOfferTime(snapshot.annualIntroOffer, now),
  };
}
export function getPublicPricingSnapshot(
  stripe: StripeClient,
): Promise<PublicPricing> {
  const key = configurationKey();
  const startedAt = Date.now();
  const current = snapshots.get(stripe);
  if (current?.key === key && Date.now() < current.expiresAt)
    return current.result;
  const next: CachedPricing = {
    key,
    expiresAt: Number.POSITIVE_INFINITY,
    result: verifyPublicPricing(stripe)
      .then(async (snapshot) => {
        snapshot = await completeSnapshot(stripe, snapshot, startedAt);
        next.expiresAt = configurationKey() === key ? expiresAt(snapshot) : 0;
        return snapshot;
      })
      .catch((error) => {
        if (snapshots.get(stripe) === next) snapshots.delete(stripe);
        throw error;
      }),
  };
  snapshots.set(stripe, next);
  return next.result;
}
