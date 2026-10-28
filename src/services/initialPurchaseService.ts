import type { StripeEffect } from "../types/stripe";
import {
  runBillingOperation,
  persistBillingAcknowledgment,
  UnresolvedBillingMutation,
  type RuntimeBillingOwner,
} from "./runtimeBillingOperationService";
import { prepareInitialOfferSettlement } from "./offerUsageSettlement";
import type { OfferUsageMutation } from "../types/offerUsage";
import {
  prepareInitialOfferReservation,
  prepareExpiredOfferRelease,
} from "./offerUsageService";
import {
  assertSessionAssociation,
  checkoutInvoiceHint,
} from "./purchaseSession";
import { reconcileSubscription } from "./subscriptionReconciliation";
import { createHash, randomUUID } from "node:crypto";
import Stripe from "stripe";
import {
  getPurchaseRepository,
  advanceAttempt,
} from "../repositories/purchaseAttemptRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import type { GuildSubscription } from "../types/db";
import type { PurchaseAttempt } from "../types/purchase";
import type { ExpectedIntroOffer, IntroOfferChoice } from "../types/pricing";
import { prepareBasicIntroCheckoutWithAuthority } from "./basicIntroOfferService";
import { isSupersedableOpen } from "./purchaseAttemptOffer";
import type { StripeClient, StripeSubscription } from "../types/stripe";
import { BillingActionError } from "./billingActionError";
import { captureEvent } from "./analyticsService";
import {
  resolvePurchaseSource,
  resolvePurchaseOffer,
  recordingLimitAnalytics,
} from "../utils/purchaseAnalytics";

const pending = () =>
  new BillingActionError(
    "BAD_REQUEST",
    "A purchase for this server is already in progress. Retry shortly or contact support.",
    "purchase_pending",
  );
const review = () =>
  new BillingActionError(
    "BAD_REQUEST",
    "Server purchase needs review. Contact support before purchasing again.",
    "purchase_needs_review",
  );
const terminal = (status: string) =>
  ["canceled", "incomplete_expired"].includes(status);
const billingUrl = (guildId: string) => `/portal/server/${guildId}/billing`;

type PurchaseInput = {
  owner?: RuntimeBillingOwner;
  effect?: StripeEffect;
  stripe: StripeClient;
  user: { id: string; email?: string; username?: string };
  guildId: string;
  mode: "live" | "test";
  checkout: Stripe.Checkout.SessionCreateParams;
  expected: GuildSubscription | undefined;
  expectedOffer?: ExpectedIntroOffer;
  offerChoice?: IntroOfferChoice;
};
type AttemptRefreshInput = Pick<
  PurchaseInput,
  "stripe" | "owner" | "guildId" | "expected"
>;

async function writePurchase(
  attempt: PurchaseAttempt,
  change: Partial<PurchaseAttempt>,
  pointer: GuildSubscription | undefined,
  usage?: OfferUsageMutation,
) {
  const next = advanceAttempt(attempt, change);
  if (
    !(await getPurchaseRepository().compareAndWrite(
      next,
      attempt,
      pointer,
      undefined,
      usage,
    ))
  )
    throw pending();
  return next;
}
const save = (
  input: Pick<PurchaseInput, "owner">,
  ...args: Parameters<typeof writePurchase>
) => input.owner!.effect(() => writePurchase(...args));

async function prepareRetiredPurchase(
  input: PurchaseInput,
  attempt: PurchaseAttempt,
) {
  if (attempt.incidentKey || attempt.state === "needs_review") throw review();
  if (attempt.state === "expired") return attempt;
  if (attempt.state !== "completed" || !attempt.subscriptionId)
    return undefined;
  const linked = await input.stripe.subscriptions.retrieve(
    attempt.subscriptionId,
  );
  assertRetiredAssociation(input, attempt, linked);
  if (!terminal(linked.status)) return undefined;
  const prepared = await prepareInitialOfferSettlement(
    input.stripe,
    attempt,
    linked,
  );
  if (prepared.kind === "pending" || prepared.kind === "awaiting_invoice")
    throw pending();
  if (prepared.kind === "voided")
    return save(
      input,
      attempt,
      { state: "expired", initialInvoiceId: prepared.invoiceId },
      input.expected,
      prepared.usage,
    );
  if (prepared.kind === "settled")
    return save(
      input,
      attempt,
      { initialInvoiceId: prepared.invoiceId },
      input.expected,
      prepared.usage,
    );
  return attempt;
}

function assertRetiredAssociation(
  input: PurchaseInput,
  attempt: PurchaseAttempt,
  linked: Awaited<ReturnType<StripeClient["subscriptions"]["retrieve"]>>,
) {
  if (
    linked.id !== attempt.subscriptionId ||
    linked.metadata.purchase_attempt_id !== attempt.attemptId ||
    linked.metadata.discord_id !== attempt.payerId ||
    (typeof linked.customer === "string"
      ? linked.customer
      : linked.customer.id) !== attempt.customerId ||
    linked.metadata.guild_id !== input.guildId ||
    linked.livemode !== (input.mode === "live")
  )
    throw review();
}

function checkoutFingerprint(checkout: PurchaseAttempt["checkout"]): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        ...checkout,
        metadata: undefined,
        success_url: undefined,
        cancel_url: undefined,
        subscription_data: {
          ...checkout.subscription_data,
          metadata: undefined,
        },
      }),
    )
    .digest("hex");
  return fingerprint;
}

function subscriptionPointerChanged(
  pointer: GuildSubscription | undefined,
  expected: GuildSubscription | undefined,
): boolean {
  return (
    pointer?.stripeSubscriptionId !== expected?.stripeSubscriptionId ||
    pointer?.stripeSyncRevision !== expected?.stripeSyncRevision
  );
}

type PurchasePreparation =
  | { kind: "new"; previous: PurchaseAttempt | undefined }
  | { kind: "reuse"; current: PurchaseAttempt };
async function preparePurchaseAttempt(
  input: PurchaseInput,
): Promise<PurchasePreparation> {
  const current = await refreshAttempt(
    input,
    await getPurchaseRepository().get(input.guildId),
  );
  if (!current) return { kind: "new", previous: undefined };
  const retired = await prepareRetiredPurchase(input, current);
  return retired
    ? { kind: "new", previous: retired }
    : { kind: "reuse", current };
}
const changesFrozenChoice = (error: unknown) =>
  error instanceof BillingActionError &&
  (error.reason === "discount_choice_required" ||
    error.reason === "offer_changed_terms");

/** Decides whether a request resumes `current`, supersedes it, or is refused. */
async function prepareReuse(input: PurchaseInput, current: PurchaseAttempt) {
  const open = isSupersedableOpen(current);
  // Another payer never reaches the frozen-offer reuse checks.
  if (current.mode !== input.mode || current.payerId !== input.user.id) {
    if (open) return "supersede";
    throw pending();
  }
  try {
    const { checkout } = await prepareBasicIntroCheckoutWithAuthority({
      ...input,
      current,
    });
    if (current.fingerprint === checkoutFingerprint(checkout)) return "reuse";
    if (open) return "supersede";
  } catch (error) {
    if (open && changesFrozenChoice(error)) return "supersede";
    throw error;
  }
  throw pending();
}

async function reuseOpenOrCurrentAttempt(
  input: PurchaseInput,
  current: PurchaseAttempt,
): Promise<PurchaseAttempt | "superseded"> {
  if ((await prepareReuse(input, current)) === "supersede")
    return supersedeOpenAttempt(input, current);
  if (
    input.checkout.metadata?.analytics_opt_out === "true" &&
    !current.analyticsOptOut
  )
    return save(input, current, { analyticsOptOut: true }, input.expected);
  return current;
}

/**
 * Expires the open session at Stripe, then lets a provider read decide: only
 * a Stripe-confirmed expiry with no subscription releases the attempt.
 */
async function supersedeOpenAttempt(
  input: PurchaseInput,
  current: PurchaseAttempt,
): Promise<PurchaseAttempt | "superseded"> {
  // Once the expire is acknowledged any refusal is an unknown billing outcome,
  // so the replacement's offer terms are checked first, without the old hold.
  await prepareBasicIntroCheckoutWithAuthority({
    ...input,
    releasing: current.attemptId,
  });
  try {
    await input.owner!.effect(() =>
      input.stripe.checkout.sessions.expire(current.sessionId!, undefined, {
        idempotencyKey: `purchase-supersede-${current.attemptId}`,
      }),
    );
  } catch (error) {
    // A refused expire means the session already left `open`; the provider read below decides.
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError))
      throw error;
  }
  let after: PurchaseAttempt | undefined;
  try {
    after = await refreshAttempt(input, current);
  } catch (error) {
    // Another writer (often the expiry webhook this expire triggers) moved the
    // attempt first, so the release check failed against stale state; re-read.
    // An unknown write outcome must still surface.
    if (error instanceof UnresolvedBillingMutation) throw error;
    const row = await getPurchaseRepository().get(input.guildId);
    if (row?.revision !== current.revision) return "superseded";
    throw error;
  }
  if (after?.attemptId !== current.attemptId || after.state === "expired")
    return "superseded";
  if (after.state === "completed") return after;
  throw pending();
}

async function reserve(input: PurchaseInput) {
  const repo = getPurchaseRepository();
  for (let i = 0; i < 3; i++) {
    const preparation = await preparePurchaseAttempt(input);
    if (preparation.kind === "reuse") {
      const reused = await reuseOpenOrCurrentAttempt(
        input,
        preparation.current,
      );
      if (reused !== "superseded") return reused;
      continue;
    }
    const previous = preparation.previous;
    const { checkout, authority } =
      await prepareBasicIntroCheckoutWithAuthority(input);
    const fingerprint = checkoutFingerprint(checkout);
    const attemptId = randomUUID();
    const next: PurchaseAttempt = {
      guildId: input.guildId,
      attemptId,
      revision: randomUUID(),
      payerId: input.user.id,
      mode: input.mode,
      fingerprint,
      offerChoice: input.offerChoice ?? "automatic",
      analyticsOptOut: input.checkout.metadata?.analytics_opt_out === "true",
      createdAt: Date.now(),
      state: "preparing",
      checkout: {
        ...checkout,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        metadata: {
          ...checkout.metadata,
          purchase_attempt_id: attemptId,
        },
        subscription_data: {
          ...checkout.subscription_data,
          metadata: {
            ...checkout.subscription_data?.metadata,
            purchase_attempt_id: attemptId,
          },
        },
      },
    };
    const usage = await prepareInitialOfferReservation(next, authority);
    if (
      await input.owner!.effect(() =>
        repo.compareAndWrite(next, previous, input.expected, undefined, usage),
      )
    )
      return next;
    const pointer = await getSubscriptionRepository().get(input.guildId);
    if (subscriptionPointerChanged(pointer, input.expected)) throw pending();
  }
  throw pending();
}

async function customer(
  input: PurchaseInput,
  initial: PurchaseAttempt,
): Promise<PurchaseAttempt> {
  const attempt = await freezeCustomerOperation(input, initial);
  const write: StripeEffect = input.effect ?? ((run) => run());
  if (attempt.incidentKey || attempt.state === "needs_review") throw review();
  if (attempt.customerId) return attempt;
  if (attempt.state !== "preparing") throw pending();
  const operation = attempt.customerOperation;
  if (!operation) throw pending();
  let customerId: string;
  if (operation.kind === "existing") {
    const owned = await input.stripe.customers.retrieve(operation.customerId);
    if (owned.deleted || owned.metadata.discord_id !== input.user.id)
      throw review();
    customerId = owned.id;
  } else {
    const created = await write(() =>
      input.stripe.customers.create(operation.params, {
        idempotencyKey: `purchase-customer-${attempt.attemptId}`,
      }),
    );
    customerId = created.id;
  }
  const change = {
    customerId,
    checkout: { ...attempt.checkout, customer: customerId },
  };
  return operation.kind === "create"
    ? persistBillingAcknowledgment(input.owner!, () =>
        writePurchase(attempt, change, input.expected),
      )
    : save(input, attempt, change, input.expected);
}

async function currentOutcome(attempt: PurchaseAttempt): Promise<string> {
  const current = await getPurchaseRepository().get(attempt.guildId);
  if (!current || current.attemptId !== attempt.attemptId) throw pending();
  if (current.incidentKey || current.state === "needs_review") throw review();
  const pointer = await getSubscriptionRepository().get(attempt.guildId);
  if (
    current.state === "completed" &&
    current.subscriptionId &&
    pointer?.stripeSubscriptionId === current.subscriptionId
  )
    return billingUrl(attempt.guildId);
  throw pending();
}

async function completedSessionOutcome(
  input: PurchaseInput,
  attempt: PurchaseAttempt,
  session: Stripe.Checkout.Session,
): Promise<string> {
  if (!session.subscription) throw pending();
  await reconcileSubscription(
    input.stripe,
    input.guildId,
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id,
    checkoutInvoiceHint(session),
    undefined,
    input.owner,
  );
  return currentOutcome(attempt);
}

export async function recoverAcceptedPurchase(input: {
  stripe: StripeClient;
  guildId: string;
  payerId: string;
  subscription: StripeSubscription;
  owner?: RuntimeBillingOwner;
}): Promise<string | null> {
  const attempt = await getPurchaseRepository().get(input.guildId);
  if (
    input.subscription.status !== "active" ||
    !attempt ||
    !["open", "preparing"].includes(attempt.state) ||
    input.subscription.metadata.purchase_attempt_id !== attempt.attemptId
  )
    return null;
  if (attempt.payerId !== input.payerId)
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can manage this purchase.",
    );
  await reconcileSubscription(
    input.stripe,
    input.guildId,
    input.subscription.id,
    undefined,
    undefined,
    input.owner,
  );
  return currentOutcome(attempt);
}
export async function createInitialPurchase(
  input: PurchaseInput & { owner?: RuntimeBillingOwner },
): Promise<string> {
  return runBillingOperation(input.owner, async (owner) => {
    input = { ...input, owner, effect: owner.effect };
    let attempt = await reserve(input);
    const write: StripeEffect = input.effect ?? ((run) => run());
    if (attempt.state === "completed") return currentOutcome(attempt);
    await checkCheckoutReplayWindow(input, attempt);
    attempt = await customer(input, attempt);
    const pointer = await getSubscriptionRepository().get(input.guildId);
    if (!sameSubscriptionPointer(pointer, input.expected))
      return currentOutcome(attempt);
    const createsCheckout = !attempt.sessionId;
    await checkCheckoutReplayWindow(input, attempt);
    const session = attempt.sessionId
      ? await input.stripe.checkout.sessions.retrieve(attempt.sessionId)
      : await write(() =>
          input.stripe.checkout.sessions.create(attempt.checkout, {
            idempotencyKey: `purchase-checkout-${attempt.attemptId}`,
          }),
        );
    return finishCheckoutSession(input, attempt, session, createsCheckout);
  });
}

async function checkCheckoutReplayWindow(
  input: AttemptRefreshInput,
  attempt: PurchaseAttempt,
) {
  // Stripe requires 30 minutes remaining; leave one minute for the request.
  if (!attempt.sessionId && Date.now() - attempt.createdAt >= 29 * 60 * 1000) {
    await save(input, attempt, { state: "needs_review" }, input.expected);
    throw review();
  }
}

function captureNewCheckout(input: PurchaseInput, attempt: PurchaseAttempt) {
  if (
    input.checkout.metadata?.analytics_opt_out !== "true" &&
    !attempt.analyticsOptOut
  ) {
    const metadata = attempt.checkout.metadata;
    const tier = metadata?.purchase_tier;
    const interval = metadata?.purchase_interval;
    captureEvent("billing_checkout_created", {
      userId: input.user.id,
      guildId: input.guildId,
      properties: {
        tier: tier === "basic" || tier === "pro" ? tier : undefined,
        interval:
          interval === "month" || interval === "year" ? interval : undefined,
        source: resolvePurchaseSource(
          String(metadata?.purchase_source ?? "direct"),
        ),
        promo_present:
          metadata?.purchase_promo_present === "true" ||
          Boolean(metadata?.promo_code),
        offer: resolvePurchaseOffer(String(metadata?.intro_offer_id ?? "")),
        surface: "billing",
        event_version: 1,
        billing_kind: "new_subscription",
        ...recordingLimitAnalytics({
          limitType: String(metadata?.recording_limit_type ?? ""),
          limitSurface: String(metadata?.recording_limit_surface ?? ""),
        }),
      },
    });
  }
}

async function refreshAttempt(
  input: AttemptRefreshInput,
  initial: PurchaseAttempt | undefined,
) {
  const repo = getPurchaseRepository();
  let current = initial;
  if (current?.state === "preparing")
    await checkCheckoutReplayWindow(input, current);
  if (current?.sessionId && current.state === "open" && !current.incidentKey) {
    const session = await input.stripe.checkout.sessions.retrieve(
      current.sessionId,
    );
    assertSessionAssociation(current, session);
    if (session.status === "expired" && !session.subscription) {
      const expired = advanceAttempt(current, { state: "expired" });
      const previous = current;
      const usage = await prepareExpiredOfferRelease(current, session);
      if (
        !(await input.owner!.effect(() =>
          repo.compareAndWrite(
            expired,
            previous,
            input.expected,
            undefined,
            usage,
          ),
        ))
      )
        throw pending();
      current = expired;
    } else if (session.status === "complete" && session.subscription) {
      await reconcileSubscription(
        input.stripe,
        input.guildId,
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription.id,
        undefined,
        undefined,
        input.owner,
      );
      current = await repo.get(input.guildId);
    }
  }

  return current;
}

/**
 * Releases an open checkout the provider has already expired, for when the
 * expiry webhook never arrives. Billing reads call it, so it never throws:
 * a Stripe outage or lost race leaves the attempt for the next load or click.
 */
export async function releaseExpiredPurchaseAttempt(input: {
  stripe: StripeClient;
  guildId: string;
  owner?: RuntimeBillingOwner;
}): Promise<void> {
  try {
    const attempt = await getPurchaseRepository().get(input.guildId);
    const pastLocalExpiry =
      isSupersedableOpen(attempt) &&
      Number(attempt.checkout.expires_at) * 1000 <= Date.now();
    if (!pastLocalExpiry) return;
    await runBillingOperation(input.owner, async (owner) =>
      refreshAttempt(
        {
          stripe: input.stripe,
          guildId: input.guildId,
          owner,
          expected: await getSubscriptionRepository().get(input.guildId),
        },
        attempt,
      ),
    );
  } catch (error) {
    console.warn("Expired checkout release deferred", {
      guildId: input.guildId,
      error,
    });
  }
}

async function findOwnedCustomer(input: PurchaseInput) {
  let existingId: string | undefined;
  if (input.user.email) {
    let after: string | undefined;
    do {
      const result = await input.stripe.customers.list({
        email: input.user.email,
        limit: 100,
        ...(after ? { starting_after: after } : {}),
      });
      existingId = result.data.find(
        (value) => value.metadata.discord_id === input.user.id,
      )?.id;
      after =
        !existingId && result.has_more ? result.data.at(-1)?.id : undefined;
    } while (after);
  }

  return existingId;
}

async function freezeCustomerOperation(
  input: PurchaseInput,
  initial: PurchaseAttempt,
): Promise<PurchaseAttempt> {
  let attempt = initial;
  if (!attempt.customerOperation) {
    const existingId = await findOwnedCustomer(input);
    const operation: PurchaseAttempt["customerOperation"] = existingId
      ? { kind: "existing", customerId: existingId }
      : {
          kind: "create",
          params: {
            ...(input.user.email ? { email: input.user.email } : {}),
            metadata: {
              discord_id: input.user.id,
              discord_username: input.user.username ?? "",
              posthog_person_distinct_id: input.user.id,
            },
          },
        };
    try {
      attempt = await save(
        input,
        attempt,
        { customerOperation: operation },
        input.expected,
      );
    } catch (error) {
      const winner = await getPurchaseRepository().get(input.guildId);
      if (
        !winner ||
        winner.attemptId !== attempt.attemptId ||
        !winner.customerOperation
      )
        throw error;
      attempt = winner;
    }
  }

  return attempt;
}

function sameSubscriptionPointer(
  left: GuildSubscription | undefined,
  right: GuildSubscription | undefined,
) {
  return (
    Boolean(left) === Boolean(right) &&
    left?.stripeSubscriptionId === right?.stripeSubscriptionId &&
    left?.stripeSyncRevision === right?.stripeSyncRevision
  );
}

async function finishCheckoutSession(
  input: PurchaseInput,
  attempt: PurchaseAttempt,
  session: Stripe.Checkout.Session,
  createsCheckout: boolean,
): Promise<string> {
  assertSessionAssociation(attempt, session);
  if (session.status === "expired") {
    if (session.subscription) throw review();
    await save(
      input,
      attempt,
      { sessionId: session.id, state: "expired" },
      input.expected,
      await prepareExpiredOfferRelease(attempt, session),
    );
    throw new BillingActionError(
      "BAD_REQUEST",
      "The checkout expired. Retry to start a new purchase.",
      "purchase_expired",
    );
  }
  if (session.status === "complete") {
    return completedSessionOutcome(input, attempt, session);
  }
  if (session.status !== "open" || !session.url) throw pending();
  const receipt = async () => {
    try {
      return await writePurchase(
        attempt,
        { sessionId: session.id, state: "open" },
        input.expected,
      );
    } catch (error) {
      // Only a definite CAS rejection can use the other writer's exact completed receipt.
      if (error instanceof BillingActionError) return currentOutcome(attempt);
      throw error;
    }
  };
  const saved = createsCheckout
    ? await persistBillingAcknowledgment(input.owner!, receipt)
    : await input.owner!.effect(receipt);
  if (typeof saved === "string") return saved;
  attempt = saved;
  const current = await getPurchaseRepository().get(input.guildId);
  const latestPointer = await getSubscriptionRepository().get(input.guildId);
  if (
    current?.revision !== attempt.revision ||
    !sameSubscriptionPointer(latestPointer, input.expected)
  )
    return currentOutcome(attempt);
  if (createsCheckout) captureNewCheckout(input, attempt);
  return session.url;
}
