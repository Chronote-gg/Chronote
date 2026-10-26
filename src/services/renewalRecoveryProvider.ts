import { readRenewalPaidBasis } from "./renewalRecoveryEvidence";
import { randomUUID, createHash } from "node:crypto";
import type Stripe from "stripe";
import type {
  StripeClient,
  StripeInvoice,
  StripeSubscription,
  StripeEffect,
} from "../types/stripe";
import {
  renewalRecoveryKey,
  type RenewalRecovery,
} from "../types/renewalRecovery";
import { assertRenewalOwner } from "./renewalRecoveryEvidence";
import { changeUnavailable, stripeId } from "./billingChangeProvider";
import { inventory } from "./billingChangeRecovery";
import { releaseOwnedSchedule } from "./billingChangeSchedule";
import { getBillingChangeRepository } from "../repositories/billingChangeRepository";
import { config } from "./configService";

type Canceling = Extract<RenewalRecovery, { state: "canceling" }>;
type Input = {
  stripe: StripeClient;
  recovery: RenewalRecovery;
  now: number;
  signal?: AbortSignal;
  effect?: StripeEffect;
  onReceipt(next: RenewalRecovery): Promise<void>;
};
function assertInvoice(invoice: StripeInvoice, record: Canceling): void {
  const lines = invoice.lines.data.filter(
    (line) => line.id === record.invoice.lineId,
  );
  const line = lines[0];
  if (
    invoice.id !== record.invoice.id ||
    stripeId(invoice.customer) !== record.customerId ||
    invoice.livemode !== (record.mode === "live") ||
    stripeId(invoice.parent?.subscription_details?.subscription) !==
      record.subscriptionId ||
    invoice.lines.has_more ||
    lines.length !== 1 ||
    line.quantity !== 1 ||
    line.parent?.subscription_item_details?.subscription !==
      record.subscriptionId ||
    line.period.start !== record.invoice.periodStart ||
    line.period.end !== record.invoice.periodEnd
  )
    throw changeUnavailable();
}
function noteAmounts(note: Stripe.CreditNote) {
  const cash = Number(note.metadata?.chronote_recovery_refund);
  const credit = Number(note.metadata?.chronote_recovery_credit);
  if (
    !Number.isSafeInteger(cash) ||
    !Number.isSafeInteger(credit) ||
    cash < 0 ||
    credit < 0 ||
    cash + credit !== note.post_payment_amount
  )
    throw changeUnavailable();
  return { cash, credit };
}
function assertCreditNote(
  note: Stripe.CreditNote,
  invoice: StripeInvoice,
  record: Canceling,
): void {
  if (
    note.status !== "issued" ||
    note.metadata?.chronote_renewal_recovery !== renewalRecoveryKey(record) ||
    stripeId(note.invoice) !== invoice.id ||
    stripeId(note.customer) !== record.customerId ||
    note.livemode !== (record.mode === "live") ||
    note.currency !== invoice.currency ||
    note.amount <= 0 ||
    note.lines.has_more ||
    note.lines.data.length !== 1 ||
    note.lines.data[0].invoice_line_item !== record.invoice.lineId ||
    note.lines.data[0].quantity !== 1
  )
    throw changeUnavailable();
}
async function paidCharge(
  stripe: StripeClient,
  invoice: StripeInvoice,
  record: Canceling,
): Promise<string> {
  const payments = (
    await inventory(
      stripe.invoicePayments.list({
        invoice: invoice.id,
        status: "paid",
        limit: 100,
      }),
    )
  ).filter((payment) => (payment.amount_paid ?? 0) > 0);
  if (
    payments.length !== 1 ||
    payments[0].livemode !== invoice.livemode ||
    payments[0].currency !== invoice.currency ||
    stripeId(payments[0].invoice) !== invoice.id ||
    payments[0].payment.type !== "payment_intent"
  )
    throw changeUnavailable();
  const intentId = stripeId(payments[0].payment.payment_intent);
  if (!intentId) throw changeUnavailable();
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const charge = stripeId(intent.latest_charge);
  if (
    !charge ||
    intent.status !== "succeeded" ||
    intent.livemode !== invoice.livemode ||
    stripeId(intent.customer) !== record.customerId ||
    intent.currency !== invoice.currency ||
    intent.amount_received !== payments[0].amount_paid
  )
    throw changeUnavailable();
  return charge;
}
async function verifyCreditNoteMoney(
  stripe: StripeClient,
  invoice: StripeInvoice,
  record: Canceling,
  note: Stripe.CreditNote,
): Promise<string[]> {
  const amounts = noteAmounts(note);
  const refunded = note.refunds.reduce(
    (sum, entry) => sum + entry.amount_refunded,
    0,
  );
  if (refunded !== amounts.cash) throw changeUnavailable();
  const charge =
    amounts.cash > 0 ? await paidCharge(stripe, invoice, record) : null;
  const refunds: string[] = [];
  for (const entry of note.refunds) {
    const id = stripeId(entry.refund);
    if (!id) throw changeUnavailable();
    const refund = await stripe.refunds.retrieve(id);
    if (
      refund.status !== "succeeded" ||
      refund.currency !== invoice.currency ||
      refund.amount !== entry.amount_refunded ||
      stripeId(refund.charge) !== charge
    )
      throw changeUnavailable();
    refunds.push(id);
  }
  if (amounts.credit > 0) {
    const id = stripeId(note.customer_balance_transaction);
    if (!id) throw changeUnavailable();
    const credit = await stripe.customers.retrieveBalanceTransaction(
      record.customerId,
      id,
    );
    if (
      credit.amount !== -amounts.credit ||
      credit.currency !== invoice.currency
    )
      throw changeUnavailable();
  }
  return refunds;
}
export async function hasProcessingRenewalPayment(
  stripe: StripeClient,
  invoice: StripeInvoice,
  record: Pick<RenewalRecovery, "customerId">,
): Promise<boolean> {
  for (const payment of await inventory(
    stripe.invoicePayments.list({
      invoice: invoice.id,
      status: "open",
      limit: 100,
    }),
  )) {
    if (payment.status !== "open") continue;
    if (
      stripeId(payment.invoice) !== invoice.id ||
      payment.livemode !== invoice.livemode ||
      payment.payment.type !== "payment_intent"
    )
      throw changeUnavailable();
    const id = stripeId(payment.payment.payment_intent);
    if (!id) throw changeUnavailable();
    const intent = await stripe.paymentIntents.retrieve(id);
    if (
      stripeId(intent.customer) !== record.customerId ||
      intent.livemode !== invoice.livemode
    )
      throw changeUnavailable();
    if (intent.status === "processing") return true;
  }
  return false;
}
async function ownedCreditNote(
  stripe: StripeClient,
  invoice: StripeInvoice,
  record: Canceling,
): Promise<Stripe.CreditNote | undefined> {
  const notes = await inventory(
    stripe.creditNotes.list({ invoice: invoice.id, limit: 100 }),
  );
  const owned = notes.filter(
    (note) =>
      note.metadata?.chronote_renewal_recovery === renewalRecoveryKey(record),
  );
  if (
    owned.length > 1 ||
    (record.receipts.creditNoteId &&
      owned[0]?.id !== record.receipts.creditNoteId)
  )
    throw changeUnavailable();
  if (owned[0]) return owned[0];
  if (
    invoice.pre_payment_credit_notes_amount ||
    invoice.post_payment_credit_notes_amount
  )
    throw changeUnavailable();
  return undefined;
}
async function createPlanCreditNote(
  stripe: StripeClient,
  invoice: StripeInvoice,
  record: Canceling,
  write: StripeEffect,
): Promise<Stripe.CreditNote> {
  const lines: Stripe.CreditNoteCreateParams.Line[] = [
    {
      type: "invoice_line_item",
      invoice_line_item: record.invoice.lineId,
      quantity: 1,
    },
  ];
  const preview = await stripe.creditNotes.preview({
    invoice: invoice.id,
    lines,
  });
  if (
    preview.amount <= 0 ||
    preview.currency !== invoice.currency ||
    preview.post_payment_amount < 0
  )
    throw changeUnavailable();
  const cash = Math.min(invoice.amount_paid, preview.post_payment_amount);
  const credit = preview.post_payment_amount - cash;
  if (cash > 0) await paidCharge(stripe, invoice, record);
  return write(() =>
    stripe.creditNotes.create(
      {
        invoice: invoice.id,
        lines,
        refund_amount: cash || undefined,
        credit_amount: credit || undefined,
        reason: "order_change",
        email_type: "none",
        metadata: {
          chronote_renewal_recovery: renewalRecoveryKey(record),
          chronote_recovery_refund: String(cash),
          chronote_recovery_credit: String(credit),
        },
      },
      {
        idempotencyKey: `${renewalRecoveryKey(record)}:credit:${cash}:${credit}`,
      },
    ),
  );
}
async function releaseRenewalSchedule(
  stripe: StripeClient,
  subscription: StripeSubscription,
  record: Canceling,
  write: StripeEffect,
): Promise<void> {
  const scheduleId = stripeId(subscription.schedule);
  if (!scheduleId) return;
  if (!record.scheduledOperationId) throw changeUnavailable();
  const operation = await getBillingChangeRepository().getOperation(
    record.guildId,
    record.scheduledOperationId,
  );
  if (
    !operation ||
    operation.source.subscriptionId !== record.subscriptionId ||
    operation.source.customerId !== record.customerId ||
    operation.mode !== record.mode
  )
    throw changeUnavailable();
  if (!(await releaseOwnedSchedule(stripe, operation, scheduleId, write)))
    throw changeUnavailable();
}
function collectionMarker(record: Canceling): string {
  return (
    "chronote_collection_" +
    createHash("sha256")
      .update(renewalRecoveryKey(record))
      .digest("hex")
      .slice(0, 16)
  );
}
async function restoreCollection(
  stripe: StripeClient,
  record: Canceling,
  write: StripeEffect,
): Promise<void> {
  if (record.receipts.collectionRestored) return;
  if (record.receipts.collectionToRestore === null) throw changeUnavailable();
  const marker = collectionMarker(record);
  for (const id of record.receipts.collectionToRestore) {
    let invoice = await stripe.invoices.retrieve(id);
    if (
      stripeId(invoice.customer) !== record.customerId ||
      invoice.livemode !== (record.mode === "live")
    )
      throw changeUnavailable();
    if (
      !["open", "draft"].includes(invoice.status ?? "") ||
      invoice.metadata?.[marker] === "restored"
    )
      continue;
    if (invoice.auto_advance) continue;
    invoice = await write(() =>
      stripe.invoices.update(
        id,
        { auto_advance: true, metadata: { [marker]: "restored" } },
        { idempotencyKey: `${renewalRecoveryKey(record)}:restore:${id}` },
      ),
    );
    if (!invoice.auto_advance || invoice.metadata?.[marker] !== "restored")
      throw changeUnavailable();
  }
}
async function collectionBeforeCancellation(
  stripe: StripeClient,
  record: Canceling,
  save: (receipts: Canceling["receipts"]) => Promise<Canceling>,
): Promise<Canceling> {
  const invoice = await stripe.invoices.retrieve(record.invoice.id);
  record = await snapshotCollection(stripe, invoice, record, save);
  const ids: string[] = [];
  for (const before of record.receipts.unrelatedInvoices) {
    if (!before.autoAdvance) continue;
    const invoice = await stripe.invoices.retrieve(before.id);
    if (
      stripeId(invoice.customer) !== record.customerId ||
      invoice.livemode !== (record.mode === "live")
    )
      throw changeUnavailable();
    const ownPause =
      invoice.id === record.invoice.id &&
      invoice.metadata?.chronote_renewal_pause === renewalRecoveryKey(record);
    if (invoice.auto_advance || ownPause) ids.push(invoice.id);
  }
  return save({ ...record.receipts, collectionToRestore: ids });
}
export async function cancelUnpaidRenewal(
  input: Input,
): Promise<
  | "paid"
  | "canceled"
  | "pending"
  | { kind: "superseded"; paid: RenewalRecovery["paid"] }
> {
  if (
    input.recovery.state !== "canceling" ||
    input.recovery.mode !== config.subscription.stripeMode
  )
    throw changeUnavailable();
  const stripe = input.stripe;
  const write: StripeEffect = (run) => {
    input.signal?.throwIfAborted();
    return input.effect ? input.effect(run) : run();
  };
  let record = input.recovery;
  const save = async (receipts: Canceling["receipts"]) => {
    const next = { ...record, revision: randomUUID(), receipts };
    await input.onReceipt(next);
    record = next;
    return next;
  };
  const subscription = await stripe.subscriptions.retrieve(
    record.subscriptionId,
  );
  assertRenewalOwner(subscription, record);
  const customer = await stripe.customers.retrieve(record.customerId);
  if (
    customer.deleted ||
    customer.livemode !== (record.mode === "live") ||
    customer.metadata.discord_id !== record.payerId
  )
    throw changeUnavailable();
  const debt = await settleRenewalDebt(
    stripe,
    record,
    save,
    write,
    subscription.status === "canceled",
  );
  if (debt !== "cleared") return debt;
  const replacement = await cancelVerifiedSubscription(
    stripe,
    subscription,
    record,
    write,
    save,
  );
  if (replacement) {
    record = await collectionBeforeCancellation(stripe, record, save);
    await restoreCollection(stripe, record, write);
    await save({ ...record.receipts, collectionRestored: true });
    return { kind: "superseded", paid: replacement };
  }
  await save({ ...record.receipts, canceled: true });
  await restoreCollection(stripe, record, write);
  await save({ ...record.receipts, collectionRestored: true });
  return "canceled";
}

async function settleRenewalDebt(
  stripe: StripeClient,
  record: Canceling,
  save: (receipts: Canceling["receipts"]) => Promise<Canceling>,
  write: StripeEffect,
  alreadyCanceled: boolean,
): Promise<"paid" | "pending" | "cleared"> {
  let invoice = await stripe.invoices.retrieve(record.invoice.id);
  assertInvoice(invoice, record);
  let note = await ownedCreditNote(stripe, invoice, record);
  if (!note && invoice.status === "paid" && invoice.amount_remaining === 0)
    return "paid";
  if (!note && (await hasProcessingRenewalPayment(stripe, invoice, record)))
    return "pending";
  if (!alreadyCanceled)
    record = await snapshotCollection(stripe, invoice, record, save);
  if (!note && invoice.status !== "void") {
    if (invoice.status === "open")
      await write(() =>
        stripe.invoices.update(
          invoice.id,
          {
            auto_advance: false,
            metadata: { chronote_renewal_pause: renewalRecoveryKey(record) },
          },
          { idempotencyKey: `${renewalRecoveryKey(record)}:pause-invoice` },
        ),
      );
    invoice = await stripe.invoices.retrieve(invoice.id);
    assertInvoice(invoice, record);
    if (invoice.status === "paid" && invoice.amount_remaining === 0)
      return "paid";
    if (await hasProcessingRenewalPayment(stripe, invoice, record))
      return "pending";
    note = await createPlanCreditNote(stripe, invoice, record, write);
  }
  if (note) {
    assertCreditNote(note, invoice, record);
    const refundIds = await verifyCreditNoteMoney(
      stripe,
      invoice,
      record,
      note,
    );
    await save({ ...record.receipts, creditNoteId: note.id, refundIds });
  } else if (invoice.status !== "void" || invoice.amount_paid !== 0)
    throw changeUnavailable();
  return "cleared";
}
async function snapshotCollection(
  stripe: StripeClient,
  invoice: StripeInvoice,
  record: Canceling,
  save: (receipts: Canceling["receipts"]) => Promise<Canceling>,
): Promise<Canceling> {
  const invoices = await inventory(
    stripe.invoices.list({ customer: record.customerId, limit: 100 }),
  );
  const snapshots = [
    invoice,
    ...invoices.filter((value) => value.id !== invoice.id),
  ].filter((value) => value.status === "open" || value.status === "draft");
  const added = snapshots.filter(
    (value) =>
      !record.receipts.unrelatedInvoices.some(
        (before) => before.id === value.id,
      ),
  );
  if (!added.length) return record;
  return save({
    ...record.receipts,
    unrelatedInvoices: [
      ...record.receipts.unrelatedInvoices,
      ...added.map((value) => ({
        id: value.id,
        autoAdvance: value.auto_advance === true,
      })),
    ],
  });
}
async function cancelVerifiedSubscription(
  stripe: StripeClient,
  subscription: StripeSubscription,
  record: Canceling,
  write: StripeEffect,
  save: (receipts: Canceling["receipts"]) => Promise<Canceling>,
): Promise<RenewalRecovery["paid"] | undefined> {
  let replacement = await newerPaidCoverage(stripe, subscription, record);
  if (replacement) return replacement;
  if (subscription.status !== "canceled")
    await releaseRenewalSchedule(stripe, subscription, record, write);
  subscription = await stripe.subscriptions.retrieve(record.subscriptionId);
  assertRenewalOwner(subscription, record);
  replacement = await newerPaidCoverage(stripe, subscription, record);
  if (replacement) return replacement;
  if (
    subscription.status === "canceled" &&
    !subscription.metadata.chronote_renewal_recovery
  ) {
    // An external cancellation already changed collection settings. Preserve that current intent.
    record = await collectionBeforeCancellation(stripe, record, save);
  }
  if (subscription.status !== "canceled") {
    subscription = await write(() =>
      stripe.subscriptions.update(
        subscription.id,
        { metadata: { chronote_renewal_recovery: renewalRecoveryKey(record) } },
        { idempotencyKey: `${renewalRecoveryKey(record)}:mark-cancellation` },
      ),
    );
    assertRenewalOwner(subscription, record);
    record = await collectionBeforeCancellation(stripe, record, save);
    subscription = await stripe.subscriptions.retrieve(record.subscriptionId);
    assertRenewalOwner(subscription, record);
    replacement = await newerPaidCoverage(stripe, subscription, record);
    if (replacement) return replacement;
    subscription = await write(() =>
      stripe.subscriptions.cancel(
        subscription.id,
        { invoice_now: false, prorate: false },
        { idempotencyKey: `${renewalRecoveryKey(record)}:cancel` },
      ),
    );
  }
  assertRenewalOwner(subscription, record);
  if (
    subscription.status !== "canceled" ||
    (subscription.metadata.chronote_renewal_recovery &&
      subscription.metadata.chronote_renewal_recovery !==
        renewalRecoveryKey(record))
  )
    throw changeUnavailable();
  await assertCollectionJournalComplete(stripe, subscription, record);
}

async function assertCollectionJournalComplete(
  stripe: StripeClient,
  subscription: StripeSubscription,
  record: Canceling,
): Promise<void> {
  const invoices = await inventory(
    stripe.invoices.list({ customer: record.customerId, limit: 100 }),
  );
  const unknown = invoices.some(
    (invoice) =>
      (invoice.status === "open" || invoice.status === "draft") &&
      !invoice.auto_advance &&
      invoice.created <= (subscription.canceled_at ?? Infinity) &&
      !record.receipts.unrelatedInvoices.some(
        (before) => before.id === invoice.id,
      ),
  );
  if (unknown) throw changeUnavailable();
}
async function newerPaidCoverage(
  stripe: StripeClient,
  subscription: StripeSubscription,
  record: Canceling,
): Promise<RenewalRecovery["paid"] | undefined> {
  const invoiceId = stripeId(subscription.latest_invoice);
  if (
    subscription.status !== "active" ||
    !invoiceId ||
    invoiceId === record.invoice.id ||
    subscription.items.data[0]?.current_period_start <
      record.invoice.periodStart
  )
    return undefined;
  const paid = await readRenewalPaidBasis(
    stripe,
    subscription,
    record.guildId,
    invoiceId,
  );
  if (paid.periodStart < record.invoice.periodStart) throw changeUnavailable();
  return paid;
}
