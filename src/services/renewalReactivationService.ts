import {
  runBillingOperation,
  persistBillingAcknowledgment,
  type RuntimeBillingOwner,
} from "./runtimeBillingOperationService";
import {
  assertBillingDispatchOutcomeKnown,
  UnresolvedBillingMutation,
} from "./runtimeBillingOperationService";
import { RENEWAL_QUOTE_TTL_MS } from "../utils/renewalConstants";
import { isPurchaseAnalyticsOptedOut } from "./purchaseReconciliation";
import { captureRenewalOperationEvent } from "./billingLifecycleAnalytics";
import {
  renewalBindingSchema,
  renewalOperationSchema,
  type RenewalTerms,
  type RenewalQuote,
} from "../types/renewal";
import { randomUUID } from "node:crypto";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { getRenewalReactivationRepository } from "../repositories/renewalReactivationRepository";
import type { StripeClient } from "../types/stripe";
import type {
  RenewalOperation,
  RenewalRequest,
  RenewalResult,
  RenewalView,
  RenewalState,
} from "../types/renewal";
import { config } from "./configService";
import {
  readRenewalSource,
  clearPendingCancellation,
  type RenewalSource,
} from "./renewalProvider";
import {
  readRenewalQuote,
  readRenewalRecoveryQuote,
  signRenewalQuote,
} from "./renewalQuote";
import { reconcileSubscription } from "./subscriptionReconciliation";
import { BillingActionError } from "./billingActionError";
type Context = {
  stripe: StripeClient;
  guildId: string;
  payerId: string;
  now?: number;
  owner?: RuntimeBillingOwner;
};
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const isPayer = (source: RenewalSource, payerId: string) =>
  source.customer.metadata.discord_id === payerId;
function operationState(
  operation: RenewalOperation,
  knownEndsAt: string | null,
): RenewalState {
  return operation.state === "needs_review"
    ? { kind: "needs_review", operationId: operation.operationId, knownEndsAt }
    : {
        kind: "processing",
        operationId: operation.operationId,
        endsAt: operation.approvedTerms.renewsAt,
      };
}
export async function readRenewalState({
  stripe,
  guildId,
  payerId,
  now = Date.now(),
}: Context): Promise<RenewalView> {
  const saved = await getSubscriptionRepository().get(guildId);
  let lifecycleAllowed = false;
  const view = (
    state: RenewalState,
    canManageBilling = false,
  ): RenewalView => ({
    state,
    canManageBilling,
    lifecycleAnalyticsEnabled:
      config.analytics.billingLifecycleEnabled && lifecycleAllowed,
  });
  if (!saved?.stripeSubscriptionId) return view({ kind: "not_applicable" });
  let recovery: RenewalOperation | undefined;
  try {
    const control = await getRenewalReactivationRepository().getControl({
      guildId,
    });
    const controlPresent = Boolean(control);
    if (control) {
      const operation = await getRenewalReactivationRepository().getOperation({
        guildId,
        operationId: control.operationId,
      });
      if (
        operation &&
        operation.payerId === payerId &&
        operation.subscriptionId === saved.stripeSubscriptionId &&
        operation.state !== "succeeded" &&
        operation.state !== "rejected"
      )
        recovery = operation;
    }
    const source = await readRenewalSource({
      stripe,
      guildId,
      subscriptionId: saved.stripeSubscriptionId,
    });
    lifecycleAllowed = !(await isPurchaseAnalyticsOptedOut(
      guildId,
      source.subscription,
    ).catch(() => true));
    const payer = isPayer(source, payerId);
    if (source.kind === "terminal") return view({ kind: "terminal" }, payer);
    if (payer && recovery)
      return view(
        operationState(
          recovery,
          source.cancellationAt ? iso(source.cancellationAt) : null,
        ),
        payer,
      );
    if (
      source.cancellationAt === null &&
      ["past_due", "unpaid"].includes(source.subscription.status)
    )
      return view({ kind: "payment_problem" }, payer);
    if (source.cancellationAt === null)
      return source.kind === "verified"
        ? view({ kind: "on", terms: source.terms }, payer)
        : view({ kind: "unavailable", knownEndsAt: null }, payer);
    const tier = source.kind === "verified" ? source.terms.tier : saved.tier;
    if (tier !== "basic" && tier !== "pro")
      return view(
        { kind: "unavailable", knownEndsAt: iso(source.cancellationAt) },
        payer,
      );
    const base = {
      kind: "off",
      tier,
      endsAt: iso(source.cancellationAt),
    } satisfies Pick<
      Extract<RenewalState, { kind: "off" }>,
      "kind" | "tier" | "endsAt"
    >;
    if (!payer) return view({ ...base, action: { kind: "payer_required" } });
    if (controlPresent && !recovery)
      return view(
        {
          ...base,
          action: { kind: "review_in_stripe", reason: "unsupported_state" },
        },
        true,
      );
    if (source.kind !== "verified")
      return view(
        {
          ...base,
          action: { kind: "review_in_stripe", reason: source.reason },
        },
        true,
      );
    if (!config.stripe.renewalReactivationEnabled)
      return view(
        {
          ...base,
          action: { kind: "review_in_stripe", reason: "direct_unavailable" },
        },
        true,
      );
    if (source.cancellationAt * 1000 <= now)
      return view(
        {
          ...base,
          action: { kind: "review_in_stripe", reason: "unverified_terms" },
        },
        true,
      );
    const quote: RenewalQuote = {
      purpose: "billing_renewal_v1",
      nonce: randomUUID(),
      guildId,
      payerId,
      subscriptionId: source.subscription.id,
      sourceRevision: saved.stripeSyncRevision ?? null,
      sourceFingerprint: source.sourceFingerprint,
      terms: source.terms,
      issuedAt: now,
      expiresAt: now + RENEWAL_QUOTE_TTL_MS,
    };
    return view(
      {
        ...base,
        action: {
          kind: "ready",
          terms: quote.terms,
          quoteToken: signRenewalQuote(quote),
          expiresAt: quote.expiresAt,
        },
      },
      true,
    );
  } catch {
    if (recovery)
      return view(
        operationState(
          recovery,
          saved.cancellationAt ?? recovery.approvedTerms.renewsAt,
        ),
      );
    return view({
      kind: "unavailable",
      knownEndsAt: saved.cancellationAt ?? null,
    });
  }
}
export async function restoreRenewal({
  owner,
  stripe,
  guildId,
  payerId,
  request,
  analyticsOptOut,
  now = Date.now(),
}: Context & {
  request: RenewalRequest;
  analyticsOptOut: boolean;
}): Promise<RenewalResult> {
  return runBillingOperation(owner, async (owner) => {
    const repo = getRenewalReactivationRepository();
    const signed =
      request.kind === "confirm"
        ? readRenewalRecoveryQuote(request.quoteToken, { guildId, payerId })
        : undefined;
    const operationId =
      request.kind === "recover" ? request.operationId : signed?.nonce;
    if (!operationId) return { kind: "changed" };
    const prior = await repo.getOperation({ guildId, operationId });
    if (prior)
      return restorePriorRenewal(
        { stripe, guildId, payerId, now, owner },
        prior,
        signed,
        analyticsOptOut,
      );
    if (request.kind !== "confirm" || !config.stripe.renewalReactivationEnabled)
      return { kind: "changed" };
    const quote = readRenewalQuote(request.quoteToken, now, {
      guildId,
      payerId,
    });
    if (!quote) return { kind: "changed" };
    return startRenewal(
      { stripe, guildId, payerId, now, owner },
      quote,
      analyticsOptOut,
    );
  });
}
type RecoveryState =
  | { state: "verifying" }
  | { state: "succeeded"; verifiedTerms: RenewalTerms }
  | { state: "needs_review"; reason: "terms_changed" | "retry_window_elapsed" };
type VerifiedSource = Extract<RenewalSource, { kind: "verified" }>;
type RecoveryAttempt =
  | { kind: "source"; source: RenewalSource }
  | { kind: "result"; result: RenewalResult };

async function recover(
  context: Required<Context>,
  operation: RenewalOperation,
): Promise<RenewalResult> {
  return new RenewalRecovery(context, operation).run();
}

class RenewalRecovery {
  private privacySuppressed: boolean;
  private readonly repo = getRenewalReactivationRepository();

  constructor(
    private readonly context: Required<Context>,
    private operation: RenewalOperation,
  ) {
    this.privacySuppressed = operation.analyticsOptOut;
  }

  async run(): Promise<RenewalResult> {
    try {
      return await this.runChecked();
    } catch (error) {
      return this.handleError(error);
    }
  }

  private next(result: RecoveryState): RenewalOperation {
    return renewalOperationSchema.parse({
      ...renewalBindingSchema.parse(this.operation),
      revision: randomUUID(),
      analyticsOptOut: this.privacySuppressed,
      ...result,
    });
  }

  private async save(next: RenewalOperation) {
    const accepted = await this.repo.compareAndWrite({
      next,
      expectedRevision: this.operation.revision,
    });
    if (
      accepted &&
      this.operation.state !== "needs_review" &&
      ["succeeded", "rejected", "needs_review"].includes(next.state)
    )
      await captureRenewalOperationEvent({ operation: next, phase: "result" });
    return accepted;
  }

  private processing(): RenewalResult {
    return { kind: "processing", operationId: this.operation.operationId };
  }

  private async needsReview(
    reason: "terms_changed" | "retry_window_elapsed",
  ): Promise<RenewalResult> {
    await this.save(this.next({ state: "needs_review", reason }));
    return { kind: "needs_review", operationId: this.operation.operationId };
  }

  private matches(source: RenewalSource): source is VerifiedSource {
    return (
      source.kind === "verified" &&
      source.invariantFingerprint === this.operation.invariantFingerprint
    );
  }

  private completed(source: RenewalSource): RenewalResult {
    return this.matches(source) && source.cancellationAt === null
      ? { kind: "confirmed", terms: source.terms }
      : { kind: "changed" };
  }

  private readSource() {
    return readRenewalSource({
      stripe: this.context.stripe,
      guildId: this.context.guildId,
      subscriptionId: this.operation.subscriptionId,
    });
  }

  private async retainOptOut(source: RenewalSource) {
    this.privacySuppressed = await retainRenewalOptOut(
      this.privacySuppressed,
      this.context.guildId,
      source,
    );
  }

  private async runChecked(): Promise<RenewalResult> {
    const saved = await getSubscriptionRepository().get(this.context.guildId);
    if (saved?.stripeSubscriptionId !== this.operation.subscriptionId) {
      if (this.operation.state === "succeeded") return { kind: "changed" };
      this.privacySuppressed = true;
      return this.needsReview("terms_changed");
    }
    let source = await this.readSource();
    if (!isPayer(source, this.context.payerId))
      throw new BillingActionError(
        "FORBIDDEN",
        "Only the original payer can manage this server's Stripe billing",
      );
    if (this.operation.state === "succeeded") return this.completed(source);
    await this.retainOptOut(source);
    if (!this.matches(source)) return this.needsReview("terms_changed");
    if (source.cancellationAt !== null) {
      const attempt = await this.applyCancellation(source);
      if (attempt.kind === "result") return attempt.result;
      source = attempt.source;
    }
    if (!this.matches(source)) return this.needsReview("terms_changed");
    if (source.cancellationAt !== null) return this.processing();
    return this.confirm();
  }

  private async applyCancellation(
    source: VerifiedSource,
  ): Promise<RecoveryAttempt> {
    if (source.sourceFingerprint !== this.operation.sourceFingerprint)
      return {
        kind: "result",
        result: await this.needsReview("terms_changed"),
      };
    if (this.context.now - this.operation.firstAttemptAt >= 23 * 60 * 60 * 1000)
      return {
        kind: "result",
        result: await this.needsReview("retry_window_elapsed"),
      };
    if (
      !config.stripe.renewalReactivationEnabled ||
      this.operation.state === "needs_review"
    )
      return { kind: "result", result: this.processing() };
    let acknowledged = false;
    try {
      await this.context.owner.effect(() =>
        clearPendingCancellation({
          stripe: this.context.stripe,
          operation: this.operation,
        }),
      );
      acknowledged = true;
    } catch (error) {
      assertBillingDispatchOutcomeKnown(error);
      // A definite rejection may be reconciled against existing provider state.
    }
    if (this.operation.state === "applying") {
      const verifying = this.next({ state: "verifying" });
      const saved = acknowledged
        ? await persistBillingAcknowledgment(() => this.save(verifying))
        : await this.save(verifying);
      if (!saved) return { kind: "result", result: this.processing() };
      this.operation = verifying;
    }
    const current = await this.readSource();
    await this.retainOptOut(current);
    return { kind: "source", source: current };
  }

  private async confirm(): Promise<RenewalResult> {
    const { stripe, guildId, payerId } = this.context;
    await reconcileSubscription(
      stripe,
      guildId,
      this.operation.subscriptionId,
      undefined,
      { userId: payerId, analyticsOptOut: this.privacySuppressed },
    );
    const persisted = await getSubscriptionRepository().get(guildId);
    const confirmed = await this.readSource();
    await this.retainOptOut(confirmed);
    if (
      !this.matches(confirmed) ||
      confirmed.cancellationAt !== null ||
      persisted?.stripeSubscriptionId !== this.operation.subscriptionId ||
      persisted.cancellationAt
    )
      return this.processing();
    if (
      !(await this.save(
        this.next({ state: "succeeded", verifiedTerms: confirmed.terms }),
      ))
    )
      return this.processing();
    return { kind: "confirmed", terms: confirmed.terms };
  }

  private async handleError(error: unknown): Promise<RenewalResult> {
    if (error instanceof UnresolvedBillingMutation) throw error;
    if (error instanceof BillingActionError && error.code === "FORBIDDEN")
      throw error;
    if (error instanceof BillingActionError && error.code === "BAD_REQUEST") {
      if (this.operation.state === "succeeded") return { kind: "changed" };
      this.privacySuppressed = true;
      try {
        if (
          await this.save(
            this.next({ state: "needs_review", reason: "terms_changed" }),
          )
        )
          return {
            kind: "needs_review",
            operationId: this.operation.operationId,
          };
      } catch {
        /* Keep the existing durable control if persistence is unavailable. */
      }
    }
    return this.processing();
  }
}

async function retainRenewalOptOut(
  suppressed: boolean,
  guildId: string,
  source: RenewalSource,
): Promise<boolean> {
  return (
    suppressed ||
    (await isPurchaseAnalyticsOptedOut(guildId, source.subscription).catch(
      () => true,
    ))
  );
}

async function restorePriorRenewal(
  context: Required<Context>,
  prior: RenewalOperation,
  signed: RenewalQuote | undefined,
  analyticsOptOut: boolean,
): Promise<RenewalResult> {
  const { payerId } = context;
  const repo = getRenewalReactivationRepository();
  if (prior.payerId !== payerId)
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can manage this server's Stripe billing",
    );
  if (
    signed &&
    (signed.subscriptionId !== prior.subscriptionId ||
      signed.sourceFingerprint !== prior.sourceFingerprint)
  )
    return { kind: "changed" };
  if (prior.state === "rejected") return { kind: "changed" };
  if (
    analyticsOptOut &&
    !prior.analyticsOptOut &&
    prior.state !== "succeeded"
  ) {
    const optedOut = {
      ...prior,
      analyticsOptOut: true,
      revision: randomUUID(),
    };
    if (
      !(await repo.compareAndWrite({
        next: optedOut,
        expectedRevision: prior.revision,
      }))
    )
      return { kind: "processing", operationId: prior.operationId };
    prior = optedOut;
  }
  return recover(context, prior);
}
async function startRenewal(
  context: Required<Context>,
  quote: RenewalQuote,
  analyticsOptOut: boolean,
): Promise<RenewalResult> {
  const { stripe, guildId, payerId, now } = context;
  const repo = getRenewalReactivationRepository();
  const saved = await getSubscriptionRepository().get(guildId);
  if (
    !saved ||
    saved.stripeSubscriptionId !== quote.subscriptionId ||
    (saved.stripeSyncRevision ?? null) !== quote.sourceRevision
  )
    return { kind: "changed" };
  const source = await readRenewalSource({
    stripe,
    guildId,
    subscriptionId: quote.subscriptionId,
  });
  if (!isPayer(source, payerId))
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can manage this server's Stripe billing",
    );
  if (
    source.kind !== "verified" ||
    source.cancellationAt === null ||
    source.sourceFingerprint !== quote.sourceFingerprint
  )
    return { kind: "changed" };
  const operation: RenewalOperation = {
    operationId: quote.nonce,
    quoteNonce: quote.nonce,
    guildId,
    payerId,
    mode: source.subscription.livemode ? "live" : "test",
    subscriptionId: source.subscription.id,
    sourceFingerprint: source.sourceFingerprint,
    invariantFingerprint: source.invariantFingerprint,
    sourceRevision: quote.sourceRevision,
    approvedTerms: quote.terms,
    stripeRequest: source.stripeRequest,
    idempotencyKey: `renewal-${source.subscription.livemode ? "live" : "test"}-${guildId}-${quote.nonce}`,
    firstAttemptAt: now,
    analyticsOptOut:
      analyticsOptOut ||
      (await isPurchaseAnalyticsOptedOut(guildId, source.subscription).catch(
        () => true,
      )),
    revision: randomUUID(),
    state: "applying",
  };
  if (!(await repo.claim({ operation, expectedSubscription: saved })))
    return { kind: "changed" };
  await captureRenewalOperationEvent({ operation, phase: "requested" });
  return recover(context, operation);
}
