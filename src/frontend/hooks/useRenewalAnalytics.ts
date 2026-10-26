import { useEffect, useRef, useMemo } from "react";
import type { RenewalView } from "../../types/renewal";
import { track, isDoNotTrackEnabled } from "../services/analytics";
function offState(view: RenewalView | undefined) {
  return view?.state.kind === "off" ? view.state : undefined;
}
export function useRenewalAnalytics({
  view,
  serverId,
  active,
}: {
  view: RenewalView | undefined;
  serverId: string | null;
  active: boolean;
}) {
  const seen = useRef(new Set<string>());
  const state = offState(view);
  const enabled = Boolean(
    active && serverId && view?.lifecycleAnalyticsEnabled,
  );
  const eligible = Boolean(
    view?.canManageBilling && state?.action.kind === "ready",
  );
  const terms = state?.action.kind === "ready" ? state.action.terms : undefined;
  const key = JSON.stringify([serverId, state?.endsAt, state?.tier, terms]);
  const properties = useMemo(
    () => ({
      guild_id: serverId ?? undefined,
      tier: state?.tier,
      interval: terms?.interval ?? "unknown",
      eligible,
      surface: "portal_billing",
      event_version: 1,
    }),
    [serverId, state?.tier, terms?.interval, eligible],
  );
  useEffect(() => {
    if (!enabled || !state || seen.current.has(key)) return;
    const element = document.querySelector('[data-testid="renewal-off"]');
    if (!element) return;
    let activeObservation = true;
    let visible = false;
    let generation = 0;
    const capture = () => {
      if (
        !activeObservation ||
        !visible ||
        document.visibilityState !== "visible" ||
        isDoNotTrackEnabled() ||
        seen.current.has(key)
      )
        return;
      seen.current.add(key);
      track("billing_renewal_off_viewed", properties);
    };
    const observe = () => {
      const current = ++generation;
      const observer = new IntersectionObserver(
        (entries) => {
          if (!activeObservation || current !== generation) return;
          const entry = entries.find((item) => item.target === element);
          if (!entry) return;
          visible =
            entry.isIntersecting &&
            entry.intersectionRatio === 1 &&
            entry.boundingClientRect.width > 0 &&
            entry.boundingClientRect.height > 0;
          capture();
        },
        { threshold: 1 },
      );
      observer.observe(element);
      return observer;
    };
    let observer = observe();
    const refresh = () => {
      visible = false;
      generation++;
      observer.disconnect();
      if (document.visibilityState === "visible") observer = observe();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      activeObservation = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, key, state, properties]);
  return () => {
    if (enabled && eligible && !isDoNotTrackEnabled())
      track("billing_renewal_reactivation_clicked", properties);
  };
}
