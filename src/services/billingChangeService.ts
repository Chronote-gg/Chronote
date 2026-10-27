import {
  runBillingOperation,
  persistBillingAcknowledgment,
  type RuntimeBillingOwner,
} from "./runtimeBillingOperationService";
import { randomUUID } from "node:crypto";
import type { StripeClient, StripeEffect } from "../types/stripe";
import {
  billingChangeOperationSchema,
  billingChangeBase,
  type BillingChangeOperation,
  type BillingChangeView,
  type BillingChangeSelection,
  type BillingChangeWrite,
} from "../types/billingChange";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { getPurchaseRepository } from "../repositories/purchaseAttemptRepository";
import { config } from "./configService";
import { BillingActionError } from "./billingActionError";
import { resolveChangeTiming } from "./billingChangePolicy";
import {
  readBillingChangeSource,
  previewBillingChange,
  changeSourceFingerprint,
  stripeId,
  changeUnavailable,
  changePending,
} from "./billingChangeProvider";
import {
  resolveBillingChangeTarget,
  billingChangeQuote,
  reserveChangeOffer,
  settleChangeOffer,
  releaseChangeOffer,
} from "./billingChangeTerms";
import {
  createChangeFundingDraft,
  finalizeChangeFunding,
  assertFundingOwner,
  verifyChangeFunding,
} from "./billingChangeFunding";
import { applyFundedBillingChange } from "./billingChangeApplication";
import { compensateChangeFunding } from "./billingChangeRecovery";
import {
  canceledBeforeSchedule,
  scheduleBillingChange,
  cancelChangeSchedule,
  readScheduledChangeSettlement,
} from "./billingChangeSchedule";
import { reconcileSubscription } from "./subscriptionReconciliation";
import {
  trackPaidRenewalPeriod,
  cancelScheduledRenewalRecovery,
} from "./renewalRecoveryService";
import { isRenewalCancellationComplete } from "../types/renewalRecovery";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";

type Context = {
  stripe: StripeClient;
  guildId: string;
  payerId: string;
  now?: number;
  effect?: StripeEffect;
  owner?: RuntimeBillingOwner;
};
const at = (context: Context) => context.now ?? Math.floor(Date.now() / 1000);
const repo = () => getBillingChangeRepository();
async function writeChange(
  next: BillingChangeOperation,
  previous: BillingChangeOperation,
  usage?: BillingChangeWrite["usage"],
) {
  const parsed = billingChangeOperationSchema.parse(next);
  if (
    !(await repo().compareAndWrite({
      next: parsed,
      expectedRevision: previous.revision,
      usage,
    }))
  )
    throw new BillingActionError(
      "BAD_REQUEST",
      "This change has been updated. Check its status before continuing.",
    );
  return parsed;
}
const persist = (context: Context, ...args: Parameters<typeof writeChange>) =>
  context.owner!.effect(() => writeChange(...args));
const persistReceipt = (
  context: Context,
  ...args: Parameters<typeof writeChange>
) => persistBillingAcknowledgment(context.owner!, () => writeChange(...args));
async function owned(context: Context, operationId?: string) {
  const control = await repo().getControl(context.guildId);
  const id = operationId ?? control?.operationId;
  if (!id) return undefined;
  const operation = await repo().getOperation(context.guildId, id);
  if (!operation) throw changeUnavailable();
  if (operation.payerId !== context.payerId)
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can manage this change.",
    );
  if (operation.mode !== config.subscription.stripeMode)
    throw changeUnavailable();
  return operation;
}
async function verifyPayer(
  context: Context,
  operation: BillingChangeOperation,
) {
  const customer = await context.stripe.customers.retrieve(
    operation.source.customerId,
  );
  if (
    customer.deleted ||
    customer.livemode !== (operation.mode === "live") ||
    customer.metadata.discord_id !== context.payerId
  )
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can manage this subscription.",
    );
}
async function present(
  context: Context,
  operation: BillingChangeOperation,
): Promise<BillingChangeView> {
  let paymentUrl: string | null = null;
  if (operation.state === "accepted" && operation.funding) {
    const invoice = await context.stripe.invoices.retrieve(
      operation.funding.invoiceId,
    );
    assertFundingOwner(invoice, operation);
    if (
      invoice.status === "open" &&
      invoice.amount_due === operation.funding.amountDue &&
      invoice.total === operation.funding.total
    )
      paymentUrl = invoice.hosted_invoice_url ?? null;
  }
  return {
    kind: "operation",
    operationId: operation.operationId,
    revision: operation.revision,
    state: operation.state,
    quote: operation.quote,
    paymentUrl,
  };
}
async function prepareBillingChangeOwned(
  context: Context & { selection: BillingChangeSelection },
): Promise<BillingChangeView> {
  const existing = await owned(context);
  if (existing) return present(context, await resume(context, existing));
  if (!config.stripe.subscriptionTransitionsEnabled)
    throw new BillingActionError(
      "BAD_REQUEST",
      "Plan changes are not available yet.",
    );
  const currentPurchase = await getPurchaseRepository().get(context.guildId);
  if (
    currentPurchase &&
    ["preparing", "open", "needs_review"].includes(currentPurchase.state)
  )
    throw changePending();
  const source = await readBillingChangeSource({ ...context, at: at(context) });
  if (source.subscription.schedule) throw changeUnavailable();
  const timing = resolveChangeTiming({
    sourceTier: source.source.tier,
    sourceInterval: source.source.interval,
    targetTier: context.selection.tier,
    targetInterval: context.selection.interval,
  });
  if (timing === "unchanged") return { kind: "none", enabled: true };
  const target = await resolveBillingChangeTarget(
    context.stripe,
    context.guildId,
    context.payerId,
    context.selection,
    source,
  );
  let quote = billingChangeQuote(source, target, timing);
  if (timing === "immediate") {
    const preview = await previewBillingChange({
      stripe: context.stripe,
      subscription: source.subscription,
      source: source.source,
      target,
    });
    const end = preview.invoice.lines.data.find(
      (line) =>
        line.amount > 0 &&
        line.pricing?.price_details?.price === target.priceId,
    )?.period.end;
    quote = {
      ...billingChangeQuote(source, target, timing),
      planCharge: preview.amounts.planCharge,
      offerSavings: preview.amounts.offerSavings,
      unusedCredit: preview.amounts.unusedCredit,
      taxAmount: preview.amounts.taxAmount,
      amountDue: preview.invoice.amount_due,
      nextAt:
        source.source.interval !== target.selection.interval
          ? null
          : end
            ? new Date(end * 1000).toISOString()
            : quote.nextAt,
    };
  }
  const operation = billingChangeOperationSchema.parse({
    guildId: context.guildId,
    operationId: randomUUID(),
    revision: randomUUID(),
    payerId: context.payerId,
    mode: config.subscription.stripeMode,
    createdAt: at(context),
    expiresAt: at(context) + 600,
    timing,
    source: source.source,
    target,
    quote,
    state: "preparing",
    draftInvoiceId: null,
  });
  const usage = await reserveChangeOffer(operation);
  if (
    !(await context.owner!.effect(() =>
      repo().claim({
        operation,
        expectedSubscription: source.saved,
        usage,
      }),
    ))
  ) {
    const winner = await owned(context);
    if (!winner) throw changeUnavailable();
    return present(context, await resume(context, winner));
  }
  return present(context, await resume(context, operation));
}
export async function readBillingChange(
  context: Context,
): Promise<BillingChangeView> {
  const operation = await owned(context);
  if (!operation)
    return {
      kind: "none",
      enabled: config.stripe.subscriptionTransitionsEnabled,
    };
  return runBillingOperation(context.owner, async (owner) => {
    const ownedContext = { ...context, owner, effect: owner.effect };
    return present(ownedContext, await resume(ownedContext, operation));
  });
}
async function confirmBillingChangeOwned(
  context: Context & { operationId: string; revision: string },
): Promise<BillingChangeView> {
  const operation = await owned(context, context.operationId);
  if (!operation) throw changeUnavailable();
  if (operation.revision !== context.revision)
    throw new BillingActionError(
      "BAD_REQUEST",
      "The review has changed. Check the current price before confirming.",
    );
  if (operation.state !== "review")
    return present(context, await resume(context, operation));
  if (at(context) >= operation.expiresAt)
    return present(
      context,
      await resume(context, await beginCancel(context, operation)),
    );
  await verifyPayer(context, operation);
  const current = await context.stripe.subscriptions.retrieve(
    operation.source.subscriptionId,
    { expand: ["discounts.source.coupon"] },
  );
  const pointer = await getSubscriptionRepository().get(context.guildId);
  if (
    pointer?.stripeSubscriptionId !== operation.source.subscriptionId ||
    changeSourceFingerprint(current) !== operation.source.fingerprint
  )
    return present(
      context,
      await resume(context, await beginCancel(context, operation)),
    );
  const accepted = await persist(
    context,
    {
      ...billingChangeBase(operation),
      revision: randomUUID(),
      state: "accepted",
      funding: operation.funding,
      consent: { at: at(context), quoteRevision: operation.revision },
    },
    operation,
  );
  return present(context, await resume(context, accepted));
}
async function cancelBillingChangeOwned(
  context: Context & { operationId: string },
): Promise<BillingChangeView> {
  let operation = await owned(context, context.operationId);
  if (!operation) throw changeUnavailable();
  await verifyPayer(context, operation);
  const recovery =
    operation.timing === "renewal"
      ? await getRenewalRecoveryRepository().getCurrent(context.guildId)
      : undefined;
  if (
    recovery?.scheduledOperationId === operation.operationId &&
    (recovery.state === "grace" || recovery.state === "canceling")
  ) {
    await cancelScheduledRenewalRecovery({
      ...context,
      operationId: operation.operationId,
      now: at(context),
    });
    const current = await owned(context, operation.operationId);
    if (!current) throw changeUnavailable();
    return present(context, current);
  }
  // Recover the idempotent scheduling write before cancellation can release
  // control. A missing schedule snapshot cannot prove an in-flight write ended.
  if (
    ["applying", "preparing", "scheduled"].includes(operation.state) ||
    (operation.state === "accepted" && operation.timing === "renewal")
  )
    operation = await resume(context, operation);
  if (
    operation.state === "succeeded" ||
    operation.state === "canceled" ||
    operation.state === "applying"
  )
    return present(context, await resume(context, operation));
  return present(
    context,
    await resume(context, await beginCancel(context, operation)),
  );
}
async function beginCancel(
  context: Context,
  operation: BillingChangeOperation,
): Promise<BillingChangeOperation> {
  if (
    operation.state === "canceling" ||
    operation.state === "canceled" ||
    operation.state === "succeeded"
  )
    return operation;
  const subscription =
    operation.timing === "renewal"
      ? await context.stripe.subscriptions.retrieve(
          operation.source.subscriptionId,
        )
      : null;
  const scheduleId =
    operation.state === "scheduled"
      ? operation.scheduleId
      : subscription
        ? (stripeId(subscription.schedule) ?? null)
        : null;
  return persist(
    context,
    {
      ...billingChangeBase(operation),
      revision: randomUUID(),
      state: "canceling",
      funding: "funding" in operation ? operation.funding : null,
      scheduleId,
      consent: "consent" in operation ? operation.consent : null,
      recovery: {
        creditNoteId: null,
        debtRefundId: null,
        balanceTransactionId: null,
      },
    },
    operation,
  );
}
async function reviewSourceEnded(
  context: Context,
  operation: BillingChangeOperation,
) {
  const pointer = await getSubscriptionRepository().get(context.guildId);
  return (
    !pointer ||
    pointer.stripeSubscriptionId !== operation.source.subscriptionId ||
    ["canceled", "incomplete_expired"].includes(pointer.status)
  );
}
async function resume(
  context: Context,
  initial: BillingChangeOperation,
): Promise<BillingChangeOperation> {
  let operation = initial;
  for (let step = 0; step < 6; step++) {
    const previousRevision = operation.revision;
    switch (operation.state) {
      case "preparing":
        operation = await prepareInvoice(context, operation);
        break;
      case "accepted":
        operation = await afterAcceptance(context, operation);
        break;
      case "applying":
        operation = await applyPayment(context, operation);
        break;
      case "scheduled":
        operation = await settleScheduled(context, operation);
        break;
      case "canceling":
        operation = await finishCancellation(context, operation);
        break;
      case "review":
        if (
          at(context) >= operation.expiresAt ||
          (await reviewSourceEnded(context, operation))
        ) {
          operation = await beginCancel(context, operation);
          break;
        }
        return operation;
      case "succeeded":
      case "canceled":
        return finishReconciliation(context, operation);
    }
    if (operation.revision === previousRevision) return operation;
  }
  return operation;
}
async function prepareInvoice(
  context: Context,
  operation: Extract<BillingChangeOperation, { state: "preparing" }>,
) {
  if (at(context) >= operation.expiresAt)
    return beginCancel(context, operation);
  let source;
  try {
    source = await readBillingChangeSource({ ...context, at: at(context) });
  } catch (error) {
    if (error instanceof BillingActionError && error.code === "BAD_REQUEST")
      return beginCancel(context, operation);
    throw error;
  }
  if (
    changeSourceFingerprint(source.subscription) !==
    operation.source.fingerprint
  )
    return beginCancel(context, operation);
  if (operation.timing === "renewal")
    return persist(
      context,
      {
        ...billingChangeBase(operation),
        revision: randomUUID(),
        state: "review",
        funding: null,
      },
      operation,
    );
  if (!operation.draftInvoiceId) {
    const draftInvoiceId = await createChangeFundingDraft({
      effect: context.effect,
      stripe: context.stripe,
      operation,
      subscription: source.subscription,
    });
    return persistReceipt(
      context,
      { ...operation, revision: randomUUID(), draftInvoiceId },
      operation,
    );
  }
  const prepared = await finalizeChangeFunding({
    effect: context.effect,
    stripe: context.stripe,
    operation,
    subscription: source.subscription,
  });
  return persistReceipt(
    context,
    {
      ...billingChangeBase(operation),
      revision: randomUUID(),
      state: "review",
      ...prepared,
    },
    operation,
  );
}
async function ensureScheduledRenewalWatch(
  context: Context,
  operation: Extract<BillingChangeOperation, { state: "accepted" }>,
): Promise<void> {
  if (operation.target.selection.tier !== "free") {
    const recovery = await getRenewalRecoveryRepository().getCurrent(
      context.guildId,
    );
    if (
      recovery?.subscriptionId !== operation.source.subscriptionId ||
      recovery.paid.periodEnd !== operation.source.periodEnd
    ) {
      const subscription = await context.stripe.subscriptions.retrieve(
        operation.source.subscriptionId,
      );
      const invoiceId = stripeId(subscription.latest_invoice);
      if (!invoiceId) throw changeUnavailable();
      await trackPaidRenewalPeriod({
        stripe: context.stripe,
        guildId: context.guildId,
        subscriptionId: operation.source.subscriptionId,
        invoiceId,
        now: at(context),
        owner: context.owner,
      });
    }
  }
}
async function afterAcceptance(
  context: Context,
  operation: Extract<BillingChangeOperation, { state: "accepted" }>,
) {
  await verifyPayer(context, operation);
  const savedPointer = await getSubscriptionRepository().get(context.guildId);
  if (
    savedPointer?.stripeSubscriptionId !== operation.source.subscriptionId ||
    (savedPointer.stripeCustomerId &&
      savedPointer.stripeCustomerId !== operation.source.customerId)
  )
    return beginCancel(context, operation);
  if (operation.timing === "renewal") {
    if (await canceledBeforeSchedule(context.stripe, operation, at(context)))
      return beginCancel(context, operation);
    await ensureScheduledRenewalWatch(context, operation);
    let latest = operation;
    const scheduleId = await scheduleBillingChange(
      context.stripe,
      operation,
      async (providerScheduleId) => {
        if (latest.providerScheduleId === providerScheduleId) return;
        const saved = await persistReceipt(
          context,
          { ...latest, revision: randomUUID(), providerScheduleId },
          latest,
        );
        if (saved.state !== "accepted") throw changeUnavailable();
        latest = saved;
      },
      context.effect,
    );
    return persistReceipt(
      context,
      {
        ...billingChangeBase(operation),
        revision: randomUUID(),
        state: "scheduled",
        scheduleId,
        consent: operation.consent,
      },
      latest,
    );
  }
  if (!operation.funding) throw changeUnavailable();
  const pointer = await getSubscriptionRepository().get(context.guildId);
  const subscription = await context.stripe.subscriptions.retrieve(
    operation.source.subscriptionId,
    { expand: ["discounts.source.coupon"] },
  );
  if (
    pointer?.stripeSubscriptionId !== operation.source.subscriptionId ||
    at(context) >= operation.source.periodEnd ||
    changeSourceFingerprint(subscription) !== operation.source.fingerprint
  )
    return beginCancel(context, operation);
  const invoice = await context.stripe.invoices.retrieve(
    operation.funding.invoiceId,
  );
  assertFundingOwner(invoice, operation);
  if (invoice.status === "open") return operation;
  if (invoice.status === "void") return beginCancel(context, operation);
  if (!verifyChangeFunding(invoice, operation, operation.funding))
    throw changeUnavailable();
  return persist(
    context,
    {
      ...billingChangeBase(operation),
      revision: randomUUID(),
      state: "applying",
      funding: operation.funding,
      consent: operation.consent,
    },
    operation,
  );
}
async function applyPayment(
  context: Context,
  operation: Extract<BillingChangeOperation, { state: "applying" }>,
) {
  await verifyPayer(context, operation);
  const pointer = await getSubscriptionRepository().get(context.guildId);
  if (
    pointer?.stripeSubscriptionId !== operation.source.subscriptionId ||
    (pointer.stripeCustomerId &&
      pointer.stripeCustomerId !== operation.source.customerId)
  )
    throw changeUnavailable();
  const result = await applyFundedBillingChange({
    effect: context.effect,
    stripe: context.stripe,
    operation,
    now: at(context),
  });
  if (result === "rejected") return beginCancel(context, operation);
  if (result === "unknown") return operation;
  const invoice = await context.stripe.invoices.retrieve(
    operation.funding.invoiceId,
  );
  const next = billingChangeOperationSchema.parse({
    ...billingChangeBase(operation),
    revision: randomUUID(),
    state: "succeeded",
    funding: operation.funding,
    scheduleId: null,
    appliedAt: at(context),
    consent: operation.consent,
    service: {
      invoiceId: result.invoice.id,
      periodStart: result.subscription.items.data[0].current_period_start,
      periodEnd: result.subscription.items.data[0].current_period_end,
    },
  });
  const completed = await persistReceipt(
    context,
    next,
    operation,
    await settleChangeOffer(next, invoice, at(context)),
  );
  return finishReconciliation(context, completed);
}
async function settleScheduled(
  context: Context,
  operation: Extract<
    BillingChangeOperation,
    { state: "scheduled" | "canceling" }
  >,
) {
  if (!operation.consent) return operation;
  const recovery = await getRenewalRecoveryRepository().getCurrent(
    context.guildId,
  );
  if (
    isRenewalCancellationComplete(recovery) &&
    recovery.scheduledOperationId === operation.operationId
  ) {
    return operation.state === "scheduled"
      ? beginCancel(context, operation)
      : operation;
  }
  const result = await readScheduledChangeSettlement(
    context.stripe,
    operation,
    context.effect,
  );
  if (result.kind === "waiting") return operation;
  const next = billingChangeOperationSchema.parse({
    ...billingChangeBase(operation),
    revision: randomUUID(),
    state: "succeeded",
    funding: null,
    scheduleId: operation.scheduleId,
    appliedAt: at(context),
    consent: operation.consent,
    ...(result.kind === "paid"
      ? {
          service: scheduledServiceReceipt(operation, result.invoice),
        }
      : {}),
  });
  const usage =
    result.kind === "paid"
      ? await settleChangeOffer(next, result.invoice, at(context))
      : undefined;
  const completed = await persistReceipt(context, next, operation, usage);
  return finishReconciliation(context, completed);
}
function scheduledServiceReceipt(
  operation: BillingChangeOperation,
  invoice: import("../types/stripe").StripeInvoice,
) {
  const line = invoice.lines.data.find(
    (line) =>
      line.pricing?.price_details?.price === operation.target.priceId &&
      line.parent?.subscription_item_details?.subscription ===
        operation.source.subscriptionId,
  );
  if (!line) throw changeUnavailable();
  return {
    invoiceId: invoice.id,
    periodStart: line.period.start,
    periodEnd: line.period.end,
  };
}
async function finishCancellation(
  context: Context,
  operation: Extract<BillingChangeOperation, { state: "canceling" }>,
) {
  await verifyPayer(context, operation);
  if (
    operation.timing === "renewal" &&
    operation.consent &&
    !(await canceledBeforeSchedule(context.stripe, operation, at(context)))
  ) {
    const settled = await settleScheduled(context, operation);
    if (settled.state === "succeeded") return settled;
    if (
      !(await cancelChangeSchedule(
        context.stripe,
        operation,
        operation.scheduleId,
        context.effect,
      ))
    )
      return operation;
  }
  let latest: BillingChangeOperation = operation;
  const recovery = await compensateChangeFunding({
    effect: context.effect,
    stripe: context.stripe,
    operation,
    onProgress: async (receipt) => {
      if (latest.state !== "canceling") throw changeUnavailable();
      latest = await persistReceipt(
        context,
        { ...latest, revision: randomUUID(), recovery: receipt },
        latest,
      );
    },
  });
  const next = billingChangeOperationSchema.parse({
    ...billingChangeBase(latest),
    revision: randomUUID(),
    state: "canceled",
    completedAt: at(context),
    recovery,
  });
  const usage = await releaseChangeOffer(
    next,
    operation.draftInvoiceId ?? operation.scheduleId ?? operation.operationId,
    at(context),
  );
  const completed = await persistReceipt(context, next, latest, usage);
  return finishReconciliation(context, completed);
}
async function finishReconciliation(
  context: Context,
  operation: BillingChangeOperation,
) {
  if (operation.state !== "succeeded" && operation.state !== "canceled")
    throw changeUnavailable();
  if (operation.reconciled) return operation;
  await reconcileSubscription(
    context.stripe,
    operation.guildId,
    operation.source.subscriptionId,
    undefined,
    undefined,
    context.owner,
  );
  return persist(
    context,
    { ...operation, revision: randomUUID(), reconciled: true },
    operation,
  );
}
export async function reconcileBillingChangeForWebhook(
  stripe: StripeClient,
  guildId: string,
  effect?: StripeEffect,
  owner?: RuntimeBillingOwner,
) {
  await runBillingOperation(owner, async (admitted) => {
    const control = await repo().getControl(guildId);
    if (!control) return;
    const operation = await repo().getOperation(guildId, control.operationId);
    if (!operation) throw changeUnavailable();
    await resume(
      {
        stripe,
        guildId,
        payerId: operation.payerId,
        effect: admitted.effect,
        owner: admitted,
      },
      operation,
    );
  });
  void effect;
}

export function prepareBillingChange(
  context: Context & { selection: BillingChangeSelection },
): Promise<BillingChangeView> {
  return runBillingOperation(context.owner, (owner) =>
    prepareBillingChangeOwned({ ...context, owner, effect: owner.effect }),
  );
}

export function confirmBillingChange(
  context: Context & { operationId: string; revision: string },
): Promise<BillingChangeView> {
  return runBillingOperation(context.owner, (owner) =>
    confirmBillingChangeOwned({ ...context, owner, effect: owner.effect }),
  );
}

export function cancelBillingChange(
  context: Context & { operationId: string },
): Promise<BillingChangeView> {
  return runBillingOperation(context.owner, (owner) =>
    cancelBillingChangeOwned({ ...context, owner, effect: owner.effect }),
  );
}
