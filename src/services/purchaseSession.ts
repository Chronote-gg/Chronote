import type Stripe from "stripe";
import type { PurchaseAttempt } from "../types/purchase";
import { BillingActionError } from "./billingActionError";
export function assertSessionAssociation(
  attempt: PurchaseAttempt,
  session: Stripe.Checkout.Session,
) {
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  if (
    !session.id ||
    (attempt.sessionId && session.id !== attempt.sessionId) ||
    session.metadata?.guild_id !== attempt.guildId ||
    session.metadata?.purchase_attempt_id !== attempt.attemptId ||
    session.livemode !== (attempt.mode === "live") ||
    customerId !== attempt.customerId
  )
    throw new BillingActionError(
      "BAD_REQUEST",
      "Server purchase needs review. Contact support before purchasing again.",
    );
}
