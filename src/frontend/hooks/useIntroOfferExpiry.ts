import { useEffect, useReducer, useRef } from "react";
import type { BasicIntroOffer } from "../../types/pricing";
type Offers = {
  introOffer?: BasicIntroOffer;
  annualIntroOffer?: BasicIntroOffer;
};
function deadline(offer: BasicIntroOffer | undefined): number | null {
  return offer?.status === "available" &&
    !offer.reservedForCheckout &&
    offer.enrollmentEndsAt
    ? Date.parse(offer.enrollmentEndsAt)
    : null;
}
const expiredOffer: BasicIntroOffer = { status: "expired" };
function expire(
  offer: BasicIntroOffer | undefined,
  now: number,
): BasicIntroOffer | undefined {
  const ends = deadline(offer);
  return ends !== null && now >= ends ? expiredOffer : offer;
}
export function useIntroOfferExpiry(
  offers: Offers | null | undefined,
  refetch: () => Promise<unknown>,
) {
  const [, updateClock] = useReducer((value: number) => value + 1, 0);
  const refresh = useRef(refetch);
  refresh.current = refetch;
  const notified = useRef(new Set<number>());
  const monthly = deadline(offers?.introOffer);
  const annual = deadline(offers?.annualIntroOffer);
  useEffect(() => {
    const deadlines = [monthly, annual].filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (timer !== undefined) clearTimeout(timer);
      const now = Date.now();
      const due = deadlines.filter(
        (value) => value <= now && !notified.current.has(value),
      );
      if (due.length) {
        due.forEach((value) => notified.current.add(value));
        updateClock();
        void refresh.current().catch(() => {});
      }
      const future = deadlines.filter((value) => value > now);
      if (future.length)
        timer = setTimeout(
          check,
          Math.min(Math.min(...future) - now, 2147483647),
        );
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [monthly, annual]);
  const now = Date.now();
  return {
    introOffer: expire(offers?.introOffer, now),
    annualIntroOffer: expire(offers?.annualIntroOffer, now),
  };
}
