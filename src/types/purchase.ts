import { normalPurchaseWriterWitnessSchema } from "./normalPurchaseWriterWitness";
import { isDeepStrictEqual } from "node:util";
import type { NormalPurchaseWriterWitness } from "./normalPurchaseWriterWitness";
import type Stripe from "stripe";
import type { IntroOfferChoice } from "./pricing";
export type PurchaseAttempt = {
  guildId: string;
  attemptId: string;
  revision: string;
  payerId: string;
  mode: "live" | "test";
  fingerprint: string;
  offerChoice?: IntroOfferChoice;
  analyticsOptOut?: boolean;
  createdAt: number;
  state: "preparing" | "open" | "completed" | "expired" | "needs_review";
  checkout: Stripe.Checkout.SessionCreateParams;
  customerOperation?:
    | { kind: "existing"; customerId: string }
    | { kind: "create"; params: Stripe.CustomerCreateParams };
  customerId?: string;
  sessionId?: string;
  subscriptionId?: string;
  initialInvoiceId?: string;
  incidentKey?: string;
  writerWitness?: NormalPurchaseWriterWitness;
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

export function assertPurchaseInvoiceBinding(
  next: PurchaseAttempt,
  expected: PurchaseAttempt | undefined,
) {
  if (next.writerWitness)
    normalPurchaseWriterWitnessSchema.parse(next.writerWitness);
  if (
    expected?.attemptId === next.attemptId &&
    expected.writerWitness &&
    !isDeepStrictEqual(next.writerWitness, expected.writerWitness)
  )
    throw new Error("Purchase writer witness cannot change");
  if (
    expected?.attemptId === next.attemptId &&
    expected.initialInvoiceId &&
    next.initialInvoiceId !== expected.initialInvoiceId
  )
    throw new Error("Initial invoice binding cannot change");
}
