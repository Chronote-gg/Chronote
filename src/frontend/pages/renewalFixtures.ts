import { RENEWAL_QUOTE_TTL_MS } from "../../utils/renewalConstants";
import type { ProviderSubscriptionDetails } from "../../types/pricing";
import type { RenewalView, RenewalTerms } from "../../types/renewal";

// Synthetic Storybook/E2E state only. Real renewal terms come from the protected API.
export function createRenewalFixture({
  details,
  cancellationAt,
  terminalStatus,
  canManageBilling = true,
}: {
  details?: ProviderSubscriptionDetails;
  cancellationAt?: string | null;
  terminalStatus?: "canceled" | "incomplete_expired";
  canManageBilling?: boolean;
}): RenewalView {
  const view = (state: RenewalView["state"]): RenewalView => ({
    state,
    canManageBilling,
    lifecycleAnalyticsEnabled: false,
  });
  if (terminalStatus) return view({ kind: "terminal" });
  if (!details)
    return view({ kind: "unavailable", knownEndsAt: cancellationAt ?? null });
  if (details.status !== "available")
    return cancellationAt
      ? view({
          kind: "off",
          tier: "basic",
          endsAt: cancellationAt,
          action: canManageBilling
            ? { kind: "unavailable" }
            : { kind: "payer_required" },
        })
      : view({ kind: "unavailable", knownEndsAt: null });
  const endsAt = cancellationAt ?? details.renewalAt;
  if (!endsAt) return view({ kind: "unavailable", knownEndsAt: null });
  const terms = fixtureTerms(details, endsAt);
  if (cancellationAt) {
    const action: Extract<RenewalView["state"], { kind: "off" }>["action"] =
      canManageBilling
        ? {
            kind: "ready",
            quoteToken: "synthetic-renewal-consent",
            expiresAt: Date.now() + RENEWAL_QUOTE_TTL_MS,
            terms,
          }
        : { kind: "payer_required" };
    return view({ kind: "off", tier: "basic", endsAt, action });
  }
  return view({ kind: "on", terms });
}

function fixtureTerms(
  details: Extract<ProviderSubscriptionDetails, { status: "available" }>,
  endsAt: string,
): RenewalTerms {
  const hasDiscount = Boolean(
    details.discount?.endsAt &&
    details.discountedUnitAmount !== null &&
    Date.parse(details.discount.endsAt) > Date.parse(endsAt),
  );
  return {
    tier: "basic",
    interval: details.interval,
    currency: details.currency,
    unitAmount: hasDiscount
      ? details.discountedUnitAmount!
      : details.unitAmount,
    taxBehavior: "exclusive",
    renewsAt: endsAt,
    discount: hasDiscount
      ? {
          endsAt: details.discount!.endsAt!,
          regularUnitAmount: details.unitAmount,
        }
      : null,
  };
}
