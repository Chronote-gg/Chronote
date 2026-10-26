import type { StripeSubscription } from "../types/stripe";

export function resolveSubscriptionCancellationAt(
  subscription: StripeSubscription,
): number | null {
  if (subscription.cancel_at != null) return subscription.cancel_at;
  if (!subscription.cancel_at_period_end) return null;
  const items = subscription.items.data;
  return items.length
    ? Math.max(...items.map((item) => item.current_period_end))
    : null;
}
