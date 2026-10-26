import type { ExpectedIntroOffer } from "../../types/pricing";
import { useEffect, useRef } from "react";
import { isDoNotTrackEnabled, track } from "../services/analytics";

export function useIntroOfferExposure({
  offer,
  entry,
  surface,
  guildId,
  enabled = true,
  observationKey,
}: {
  offer: ExpectedIntroOffer;
  entry: string;
  surface: "homepage_pricing" | "upgrade" | "portal_billing";
  guildId?: string;
  enabled?: boolean;
  observationKey?: string;
}) {
  const exposures = useRef({ entry, offers: new Set<ExpectedIntroOffer>() });
  useEffect(() => {
    if (exposures.current.entry !== entry)
      exposures.current = { entry, offers: new Set() };
    if (!enabled || offer === "none" || exposures.current.offers.has(offer))
      return;
    const terms = document.querySelector('[data-testid="basic-intro-terms"]');
    if (!terms) return;
    let active = true;
    let fullyVisible = false;
    const capture = () => {
      if (
        !active ||
        !fullyVisible ||
        document.visibilityState !== "visible" ||
        isDoNotTrackEnabled() ||
        exposures.current.offers.has(offer)
      )
        return;
      exposures.current.offers.add(offer);
      track("basic_intro_offer_exposed", {
        offer,
        interval: offer === "basic_annual_intro_v1" ? "year" : "month",
        surface,
        ...(guildId ? { guild_id: guildId } : {}),
        event_version: 1,
      });
    };
    let observationGeneration = 0;
    const createObserver = () => {
      const generation = ++observationGeneration;
      const nextObserver = new IntersectionObserver(
        (entries) => {
          if (!active || generation !== observationGeneration) return;
          const observed = entries.find((value) => value.target === terms);
          if (!observed) return;
          fullyVisible =
            observed.isIntersecting &&
            observed.intersectionRatio === 1 &&
            observed.boundingClientRect.width > 0 &&
            observed.boundingClientRect.height > 0;
          capture();
        },
        { threshold: 1 },
      );
      nextObserver.observe(terms);
      return nextObserver;
    };
    let observer = createObserver();
    const refreshVisibility = () => {
      fullyVisible = false;
      observationGeneration++;
      observer.disconnect();
      if (document.visibilityState === "visible") {
        observer = createObserver();
      }
    };
    document.addEventListener("visibilitychange", refreshVisibility);
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", refreshVisibility);
    };
  }, [offer, entry, surface, guildId, enabled, observationKey]);
}
