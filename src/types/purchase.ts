import type Stripe from "stripe";
export type PurchaseAttempt = {
  guildId: string;
  attemptId: string;
  revision: string;
  payerId: string;
  mode: "live" | "test";
  fingerprint: string;
  createdAt: number;
  state: "preparing" | "open" | "completed" | "expired" | "needs_review";
  checkout: Stripe.Checkout.SessionCreateParams;
  customerOperation?:
    | { kind: "existing"; customerId: string }
    | { kind: "create"; params: Stripe.CustomerCreateParams };
  customerId?: string;
  sessionId?: string;
  subscriptionId?: string;
  incidentKey?: string;
};
export type PurchaseIncident = {
  guildId: string;
  key: string;
  acceptedId: string;
  incomingId: string;
  acceptedStatus: string;
  incomingStatus: string;
  firstObservedAt: string;
  lastObservedAt: string;
  reason: "competing_nonterminal_subscription";
  incomingAttemptId?: string;
};
