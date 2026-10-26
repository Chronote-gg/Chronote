import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../trpc/router";

type BillingHistory = Pick<
  inferRouterOutputs<AppRouter>["billing"]["me"],
  "status" | "stripeStatus" | "hasStripeBilling"
>;
export type TerminalSubscriptionStatus = "canceled" | "incomplete_expired";

export function isTerminalStripeHistory(data: BillingHistory): boolean {
  const status = data.stripeStatus ?? data.status;
  return (
    data.hasStripeBilling &&
    (status === "canceled" || status === "incomplete_expired")
  );
}
export function requiresStripeManagement(data: BillingHistory): boolean {
  return data.hasStripeBilling && !isTerminalStripeHistory(data);
}
