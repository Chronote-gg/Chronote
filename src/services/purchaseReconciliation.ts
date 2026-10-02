import { assertSessionAssociation } from "./purchaseSession";
import { randomUUID } from "node:crypto";
import {
  getPurchaseRepository,
  advanceAttempt,
  incidentKey,
} from "../repositories/purchaseAttemptRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import type {
  StripeSubscription,
  StripeClient,
  StripeCheckoutSession,
} from "../types/stripe";
import type { PurchaseAttempt } from "../types/purchase";

export async function recordDuplicatePurchase(
  guildId: string,
  previous: StripeSubscription,
  incoming: StripeSubscription,
) {
  const repo = getPurchaseRepository();
  const mode = incoming.livemode ? "live" : "test";
  if (previous.livemode !== incoming.livemode)
    throw new Error("Subscription mode mismatch");
  const key = incidentKey(guildId, mode, previous.id, incoming.id);
  for (let i = 0; i < 3; i++) {
    const current = await repo.get(guildId);
    const pointer = await getSubscriptionRepository().get(guildId);
    if (pointer?.stripeSubscriptionId !== previous.id)
      throw new Error("Subscription pointer changed; retry");
    const blocked: PurchaseAttempt = current
      ? advanceAttempt(current, { state: "needs_review", incidentKey: key })
      : {
          guildId,
          attemptId: randomUUID(),
          revision: randomUUID(),
          payerId: "",
          mode,
          fingerprint: "",
          createdAt: Date.now(),
          state: "needs_review",
          incidentKey: key,
          checkout: {},
        };
    if (
      await repo.compareAndWrite(blocked, current, pointer, {
        guildId,
        key,
        acceptedId: previous.id,
        incomingId: incoming.id,
        acceptedStatus: previous.status,
        incomingStatus: incoming.status,
        firstObservedAt: new Date().toISOString(),
        lastObservedAt: new Date().toISOString(),
        reason: "competing_nonterminal_subscription",
        incomingAttemptId: incoming.metadata.purchase_attempt_id,
      })
    )
      return;
  }
  throw new Error("Purchase incident changed concurrently; retry");
}
export async function acceptPurchaseSubscription(
  guildId: string,
  subscription: StripeSubscription,
) {
  const repo = getPurchaseRepository();
  for (let i = 0; i < 3; i++) {
    const current = await repo.get(guildId);
    if (
      !current ||
      current.attemptId !== subscription.metadata.purchase_attempt_id
    )
      return;
    if (current.incidentKey || current.state === "needs_review") return;
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    if (
      current.mode !== (subscription.livemode ? "live" : "test") ||
      current.payerId !== subscription.metadata.discord_id ||
      current.customerId !== customerId
    )
      throw new Error("Purchase subscription association mismatch");
    const pointer = await getSubscriptionRepository().get(guildId);
    if (pointer?.stripeSubscriptionId !== subscription.id)
      throw new Error("Purchase acceptance pointer changed; retry");
    if (
      await repo.compareAndWrite(
        advanceAttempt(current, {
          state: "completed",
          subscriptionId: subscription.id,
        }),
        current,
        pointer,
      )
    )
      return;
  }
  throw new Error("Purchase attempt changed concurrently; retry");
}

export async function validatePurchaseSubscription(
  guildId: string,
  subscription: StripeSubscription,
) {
  const current = await getPurchaseRepository().get(guildId);
  if (
    !current ||
    current.attemptId !== subscription.metadata.purchase_attempt_id
  )
    return;
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  if (
    current.mode !== (subscription.livemode ? "live" : "test") ||
    current.payerId !== subscription.metadata.discord_id ||
    current.customerId !== customerId
  )
    throw new Error("Purchase subscription association mismatch");
}

export async function expirePurchaseAttempt(
  stripe: StripeClient,
  eventSession: StripeCheckoutSession,
) {
  const guildId = eventSession.metadata?.guild_id;
  const attemptId = eventSession.metadata?.purchase_attempt_id;
  if (!guildId || !attemptId) return;
  const repo = getPurchaseRepository();
  const attempt = await repo.get(guildId);
  if (
    !attempt ||
    attempt.attemptId !== attemptId ||
    !["open", "preparing"].includes(attempt.state) ||
    attempt.incidentKey
  )
    return;
  const pointer = await getSubscriptionRepository().get(guildId);
  const session = await stripe.checkout.sessions.retrieve(eventSession.id);
  assertSessionAssociation(attempt, session);
  if (session.id !== eventSession.id)
    throw new Error("Purchase session mismatch");
  if (session.status !== "expired" || session.subscription) return;
  if (
    !(await repo.compareAndWrite(
      advanceAttempt(attempt, { state: "expired", sessionId: session.id }),
      attempt,
      pointer,
    ))
  )
    throw new Error("Purchase expiration changed concurrently; retry");
}
