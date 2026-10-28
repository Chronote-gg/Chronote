import { useCallback, useEffect, useRef, useState } from "react";
import type { inferRouterInputs } from "@trpc/server";
import type { AppRouter } from "../../trpc/router";
import type { BasicIntroOffer } from "../../types/pricing";
import { showBillingError } from "../utils/billingErrorNotification";

type CheckoutAttempt = {
  identity: string;
  request: inferRouterInputs<AppRouter>["billing"]["checkout"];
  offer: BasicIntroOffer;
};

export function useCheckoutAttempt(
  identity: string,
  refreshEligibility: () => Promise<unknown>,
) {
  const [saved, setSaved] = useState<CheckoutAttempt | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const identityRef = useRef(identity);
  const attemptRef = useRef<CheckoutAttempt | null>(null);
  const refreshRef = useRef(refreshEligibility);
  const refreshPending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  identityRef.current = identity;
  refreshRef.current = refreshEligibility;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    // Clear the local view only; the provider reservation keeps its frozen terms.
    attemptRef.current = null;
    setSaved(null);
    refreshPending.current = true;
    setRefreshing(true);
    const current = ++generation.current;
    void Promise.allSettled([refreshRef.current()]).then(() => {
      if (mounted.current && generation.current === current) {
        refreshPending.current = false;
        setRefreshing(false);
      }
    });
  }, []);

  useEffect(() => {
    if (
      (attemptRef.current && attemptRef.current.identity !== identity) ||
      refreshPending.current
    )
      refresh();
  }, [identity, refresh]);

  const begin = useCallback(
    (request: CheckoutAttempt["request"], offer: BasicIntroOffer) => {
      const attempt = { identity: identityRef.current, request, offer };
      attemptRef.current = attempt;
      setSaved(attempt);
      return attempt;
    },
    [],
  );
  const isCurrent = useCallback(
    (attempt: CheckoutAttempt) =>
      mounted.current &&
      identityRef.current === attempt.identity &&
      attemptRef.current === attempt,
    [],
  );
  const retry = useCallback(
    async (
      submit: (request: CheckoutAttempt["request"]) => Promise<{ url: string }>,
    ) => {
      const attempt = attemptRef.current;
      if (!attempt || !isCurrent(attempt)) return;
      try {
        const body = await submit(attempt.request);
        if (isCurrent(attempt)) window.location.href = body.url;
      } catch (error) {
        if (isCurrent(attempt)) showBillingError(error, "checkout");
      }
    },
    [isCurrent],
  );
  return {
    attempt: saved?.identity === identity ? saved : null,
    refreshing: refreshing || Boolean(saved && saved.identity !== identity),
    begin,
    isCurrent,
    refresh,
    retry,
  };
}
