import { assertSessionAssociation } from "./purchaseSession";
import { reconcileSubscription } from "./subscriptionReconciliation";
import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import {
  getPurchaseRepository,
  advanceAttempt,
} from "../repositories/purchaseAttemptRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import type { GuildSubscription } from "../types/db";
import type { PurchaseAttempt } from "../types/purchase";
import type { StripeClient } from "../types/stripe";
import { BillingActionError } from "./billingActionError";

const pending = () =>
  new BillingActionError(
    "BAD_REQUEST",
    "A purchase for this server is already in progress. Retry shortly or contact support.",
  );
const review = () =>
  new BillingActionError(
    "BAD_REQUEST",
    "Server purchase needs review. Contact support before purchasing again.",
  );
const terminal = (status: string) =>
  ["canceled", "incomplete_expired"].includes(status);
const billingUrl = (guildId: string) => `/portal/server/${guildId}/billing`;

type PurchaseInput = {
  stripe: StripeClient;
  user: { id: string; email?: string; username?: string };
  guildId: string;
  mode: "live" | "test";
  checkout: Stripe.Checkout.SessionCreateParams;
  expected: GuildSubscription | undefined;
};

async function save(
  attempt: PurchaseAttempt,
  change: Partial<PurchaseAttempt>,
  pointer: GuildSubscription | undefined,
) {
  const next = advanceAttempt(attempt, change);
  if (!(await getPurchaseRepository().compareAndWrite(next, attempt, pointer)))
    throw pending();
  return next;
}
async function mayRetire(input: PurchaseInput, attempt: PurchaseAttempt) {
  if (attempt.incidentKey || attempt.state === "needs_review") throw review();
  if (attempt.state === "expired") return true;
  if (attempt.state !== "completed" || !attempt.subscriptionId) return false;
  const linked = await input.stripe.subscriptions.retrieve(
    attempt.subscriptionId,
  );
  if (
    linked.metadata.guild_id !== input.guildId ||
    linked.livemode !== (input.mode === "live")
  )
    throw review();
  return terminal(linked.status);
}

async function reserve(input: PurchaseInput) {
  const repo = getPurchaseRepository();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(input.checkout))
    .digest("hex");
  for (let i = 0; i < 3; i++) {
    const current = await refreshAttempt(input, await repo.get(input.guildId));
    if (current && !(await mayRetire(input, current))) {
      if (
        current.mode !== input.mode ||
        current.payerId !== input.user.id ||
        current.fingerprint !== fingerprint
      )
        throw pending();
      return current;
    }
    const attemptId = randomUUID();
    const next: PurchaseAttempt = {
      guildId: input.guildId,
      attemptId,
      revision: randomUUID(),
      payerId: input.user.id,
      mode: input.mode,
      fingerprint,
      createdAt: Date.now(),
      state: "preparing",
      checkout: {
        ...input.checkout,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        metadata: {
          ...input.checkout.metadata,
          purchase_attempt_id: attemptId,
        },
        subscription_data: {
          ...input.checkout.subscription_data,
          metadata: {
            ...input.checkout.subscription_data?.metadata,
            purchase_attempt_id: attemptId,
          },
        },
      },
    };
    if (await repo.compareAndWrite(next, current, input.expected)) return next;
    const pointer = await getSubscriptionRepository().get(input.guildId);
    if (
      pointer?.stripeSubscriptionId !== input.expected?.stripeSubscriptionId ||
      pointer?.stripeSyncRevision !== input.expected?.stripeSyncRevision
    )
      throw pending();
  }
  throw pending();
}

async function customer(
  input: PurchaseInput,
  initial: PurchaseAttempt,
): Promise<PurchaseAttempt> {
  const attempt = await freezeCustomerOperation(input, initial);
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
    const created = await input.stripe.customers.create(operation.params, {
      idempotencyKey: `purchase-customer-${attempt.attemptId}`,
    });
    customerId = created.id;
  }
  return save(
    attempt,
    {
      customerId,
      checkout: { ...attempt.checkout, customer: customerId },
    },
    input.expected,
  );
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
  );
  return currentOutcome(attempt);
}

export async function createInitialPurchase(
  input: PurchaseInput,
): Promise<string> {
  let attempt = await reserve(input);
  if (attempt.state === "completed") return currentOutcome(attempt);
  // A fixed request is no longer replayed once its safe recovery window ends.
  if (!attempt.sessionId && Date.now() - attempt.createdAt >= 60 * 60 * 1000) {
    await save(attempt, { state: "needs_review" }, input.expected);
    throw review();
  }
  attempt = await customer(input, attempt);
  const pointer = await getSubscriptionRepository().get(input.guildId);
  if (!sameSubscriptionPointer(pointer, input.expected))
    return currentOutcome(attempt);
  const session = attempt.sessionId
    ? await input.stripe.checkout.sessions.retrieve(attempt.sessionId)
    : await input.stripe.checkout.sessions.create(attempt.checkout, {
        idempotencyKey: `purchase-checkout-${attempt.attemptId}`,
      });
  assertSessionAssociation(attempt, session);
  if (session.status === "expired") {
    if (session.subscription) throw review();
    await save(
      attempt,
      { sessionId: session.id, state: "expired" },
      input.expected,
    );
    throw new BillingActionError(
      "BAD_REQUEST",
      "The checkout expired. Retry to start a new purchase.",
    );
  }
  if (session.status === "complete") {
    return completedSessionOutcome(input, attempt, session);
  }
  if (session.status !== "open" || !session.url) throw pending();
  try {
    attempt = await save(
      attempt,
      { sessionId: session.id, state: "open" },
      input.expected,
    );
  } catch {
    return currentOutcome(attempt);
  }
  const current = await getPurchaseRepository().get(input.guildId);
  const latestPointer = await getSubscriptionRepository().get(input.guildId);
  if (
    current?.revision !== attempt.revision ||
    !sameSubscriptionPointer(latestPointer, input.expected)
  )
    return currentOutcome(attempt);
  return session.url;
}

async function refreshAttempt(
  input: PurchaseInput,
  initial: PurchaseAttempt | undefined,
) {
  const repo = getPurchaseRepository();
  let current = initial;
  if (current?.sessionId && current.state === "open" && !current.incidentKey) {
    const session = await input.stripe.checkout.sessions.retrieve(
      current.sessionId,
    );
    assertSessionAssociation(current, session);
    if (session.status === "expired" && !session.subscription) {
      const expired = advanceAttempt(current, { state: "expired" });
      if (!(await repo.compareAndWrite(expired, current, input.expected)))
        throw pending();
      current = expired;
    } else if (session.status === "complete" && session.subscription) {
      await reconcileSubscription(
        input.stripe,
        input.guildId,
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription.id,
      );
      current = await repo.get(input.guildId);
    }
  }

  return current;
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
