import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { GuildSubscription } from "./db";
import {
  offerUsageSchema,
  assertUsageTransition,
  assertSettlement,
  type OfferUsageMutation,
} from "./offerUsage";
import { introOfferAuthoritySchema } from "./introOfferAuthority";
import { offerTermsSchema } from "./offerUsage";
import { introOfferIdSchema } from "./basicIntroOffers";

const id = z.string().min(1);
const seconds = z.number().int().nonnegative();
const money = z.number().int();
export const billingChangeSelectionSchema = z
  .object({
    tier: z.enum(["free", "basic", "pro"]),
    interval: z.enum(["month", "year"]),
    expectedOffer: z.enum(["none", "basic_intro_v1", "basic_annual_intro_v1"]),
  })
  .strict();
export const billingChangeQuoteSchema = z
  .object({
    targetTier: z.enum(["free", "basic", "pro"]),
    interval: z.enum(["month", "year"]),
    effectiveAt: z.iso.datetime(),
    timing: z.enum(["immediate", "renewal"]),
    currency: z.string().length(3),
    chargeLabel: id,
    chargePeriod: z.string().nullable(),
    creditLabel: id,
    planCharge: money.nonnegative(),
    offerSavings: money.nonnegative(),
    unusedCredit: money.nonnegative(),
    taxAmount: money,
    taxTreatment: z.enum(["added", "included"]),
    billingBalance: money,
    amountDue: money.nonnegative(),
    remainingCredit: money.nonnegative(),
    balanceCarriedForward: money.nonnegative().default(0),
    nextPlanRate: money.nonnegative().nullable(),
    nextAt: z.iso.datetime().nullable(),
    offerTerms: z.string().nullable(),
    endingOffer: z.enum(["monthly", "annual"]).nullable(),
  })
  .strict();
export const billingChangeSourceSchema = z
  .object({
    subscriptionId: id,
    customerId: id,
    itemId: id,
    priceId: id,
    tier: z.enum(["basic", "pro"]),
    interval: z.enum(["month", "year"]),
    periodStart: seconds,
    periodEnd: seconds,
    fingerprint: id,
    invariantFingerprint: id,
    cancellation: z
      .object({ at: seconds.nullable(), atPeriodEnd: z.boolean() })
      .strict()
      .optional(),
    productId: id,
    taxBehavior: z.enum(["inclusive", "exclusive"]),
    taxRateIds: z.array(id),
    billingMode: z.enum(["classic", "flexible"]),
    revision: z.string().nullable(),
    at: seconds,
  })
  .strict();
export const billingChangeTargetSchema = z
  .object({
    selection: billingChangeSelectionSchema,
    priceId: z.string().nullable(),
    productId: z.string().nullable(),
    unitAmount: money.nonnegative(),
    currency: id,
    taxBehavior: z.enum(["inclusive", "exclusive"]),
    offer: z
      .object({
        id: introOfferIdSchema,
        terms: offerTermsSchema,
        authority: introOfferAuthoritySchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
const funding = z
  .object({
    invoiceId: id,
    total: money,
    amountDue: money.nonnegative(),
    currency: id,
    startingBalance: money,
    endingBalance: money,
    serviceValue: money,
    targetServiceValue: money.nullable().optional(),
  })
  .strict();
const base = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  operationId: z.uuid(),
  revision: id,
  payerId: id,
  mode: z.enum(["live", "test"]),
  createdAt: seconds,
  source: billingChangeSourceSchema,
  target: billingChangeTargetSchema,
  timing: z.enum(["immediate", "renewal"]),
  quote: billingChangeQuoteSchema,
  expiresAt: seconds,
  draftInvoiceId: id.nullable().default(null),
});
const accepted = z.object({ at: seconds, quoteRevision: id }).strict();
export const billingChangeRecoverySchema = z
  .object({
    creditNoteId: id.nullable(),
    debtRefundId: id.nullable(),
    balanceTransactionId: id.nullable(),
  })
  .strict();
export type BillingChangeRecoveryReceipt = z.infer<
  typeof billingChangeRecoverySchema
>;
const emptyRecovery = {
  creditNoteId: null,
  debtRefundId: null,
  balanceTransactionId: null,
};
export const billingChangeOperationSchema = z.discriminatedUnion("state", [
  base.extend({ state: z.literal("preparing") }).strict(),
  base
    .extend({ state: z.literal("review"), funding: funding.nullable() })
    .strict(),
  base
    .extend({
      state: z.literal("accepted"),
      providerScheduleId: id.optional(),
      funding: funding.nullable(),
      consent: accepted,
    })
    .strict(),
  base
    .extend({ state: z.literal("applying"), funding, consent: accepted })
    .strict(),
  base
    .extend({
      state: z.literal("scheduled"),
      scheduleId: id.nullable(),
      consent: accepted,
    })
    .strict(),
  base
    .extend({
      state: z.literal("canceling"),
      funding: funding.nullable(),
      scheduleId: id.nullable(),
      consent: accepted.nullable(),
      recovery: billingChangeRecoverySchema.default(emptyRecovery),
    })
    .strict(),
  base
    .extend({
      state: z.literal("succeeded"),
      reconciled: z.boolean().optional(),
      funding: funding.nullable(),
      scheduleId: id.nullable(),
      appliedAt: seconds,
      service: z
        .object({ invoiceId: id, periodStart: seconds, periodEnd: seconds })
        .strict()
        .optional(),
      consent: accepted,
    })
    .strict(),
  base
    .extend({
      state: z.literal("canceled"),
      reconciled: z.boolean().optional(),
      completedAt: seconds,
      recovery: billingChangeRecoverySchema.default(emptyRecovery),
    })
    .strict(),
]);
export type BillingChangeOperation = z.infer<
  typeof billingChangeOperationSchema
>;
export type BillingChangeQuote = z.infer<typeof billingChangeQuoteSchema>;
export type BillingChangeSelection = z.infer<
  typeof billingChangeSelectionSchema
>;
export type BillingChangeSource = z.infer<typeof billingChangeSourceSchema>;
export type BillingChangeTarget = z.infer<typeof billingChangeTargetSchema>;
export type BillingChangeFunding = z.infer<typeof funding>;
export type BillingChangeView =
  | { kind: "none"; enabled: boolean }
  | {
      kind: "operation";
      operationId: string;
      revision: string;
      state: BillingChangeOperation["state"];
      quote: BillingChangeQuote;
      paymentUrl: string | null;
    };
export const billingChangeOperationKey = (
  guildId: string,
  operationId: string,
) => `CHANGE_OP#${guildId}#${operationId}`;
export const billingChangeControlKey = (guildId: string) =>
  `CHANGE_CONTROL#${guildId}`;
export const isBillingChangeComplete = (operation: BillingChangeOperation) =>
  (operation.state === "succeeded" || operation.state === "canceled") &&
  operation.reconciled === true;

export type BillingChangeClaim = {
  operation: BillingChangeOperation;
  expectedSubscription: GuildSubscription;
  usage?: OfferUsageMutation;
};
export type BillingChangeWrite = {
  next: BillingChangeOperation;
  expectedRevision: string;
  usage?: OfferUsageMutation;
};
export const billingChangeBase = (operation: BillingChangeOperation) =>
  base.parse(operation);
const transitions: Record<
  BillingChangeOperation["state"],
  BillingChangeOperation["state"][]
> = {
  preparing: ["preparing", "review", "canceling"],
  review: ["accepted", "canceling"],
  accepted: ["accepted", "applying", "scheduled", "canceling"],
  applying: ["applying", "succeeded", "canceling"],
  scheduled: ["scheduled", "succeeded", "canceling"],
  canceling: ["canceling", "canceled", "succeeded"],
  succeeded: ["succeeded"],
  canceled: ["canceled"],
};
export function assertBillingChangeTransition(
  next: BillingChangeOperation,
  previous: BillingChangeOperation,
) {
  if (
    previous.state === "canceling" &&
    next.state === "succeeded" &&
    previous.timing !== "renewal"
  )
    throw new Error(
      "Only an applied scheduled change can settle during cancellation",
    );
  next = billingChangeOperationSchema.parse(next);
  previous = billingChangeOperationSchema.parse(previous);
  if (
    !transitions[previous.state].includes(next.state) ||
    next.revision === previous.revision
  )
    throw new Error("Invalid plan change state transition");
  assertReconciliationTransition(next, previous);
  assertScheduleReceiptTransition(next, previous);
  assertFrozenChangeTerms(next, previous);
  if (
    "funding" in previous &&
    "funding" in next &&
    !isDeepStrictEqual(previous.funding, next.funding)
  )
    throw new Error("Bound plan change invoice cannot change");
  if (
    "consent" in previous &&
    previous.consent &&
    "consent" in next &&
    !isDeepStrictEqual(previous.consent, next.consent)
  )
    throw new Error("Plan change consent cannot change");
}

function assertReconciliationTransition(
  next: BillingChangeOperation,
  previous: BillingChangeOperation,
) {
  if (next.state === "succeeded" || next.state === "canceled") {
    if (previous.state === next.state) {
      const {
        revision: oldRevision,
        reconciled: oldReconciled,
        ...oldResult
      } = previous;
      const {
        revision: newRevision,
        reconciled: newReconciled,
        ...newResult
      } = next;
      if (
        oldReconciled === true ||
        newReconciled !== true ||
        !isDeepStrictEqual(oldResult, newResult)
      )
        throw new Error(
          "Only entitlement reconciliation can complete a settled change",
        );
      void oldRevision;
      void newRevision;
    } else if (next.reconciled === true) {
      throw new Error("Settled change requires entitlement reconciliation");
    }
  }
}
function assertScheduleReceiptTransition(
  next: BillingChangeOperation,
  previous: BillingChangeOperation,
) {
  if (previous.state === "accepted" && next.state === "accepted") {
    const {
      revision: oldRevision,
      providerScheduleId: oldSchedule,
      ...oldAccepted
    } = previous;
    const {
      revision: newRevision,
      providerScheduleId: newSchedule,
      ...newAccepted
    } = next;
    if (
      oldSchedule ||
      !newSchedule ||
      !isDeepStrictEqual(oldAccepted, newAccepted)
    )
      throw new Error("Only the first native schedule receipt can be bound");
    void oldRevision;
    void newRevision;
  }
  if (
    previous.state === "accepted" &&
    previous.providerScheduleId &&
    next.state === "scheduled" &&
    next.scheduleId !== previous.providerScheduleId
  )
    throw new Error("Bound native schedule cannot change");
}

export function parseChangeUsage(
  operation: BillingChangeOperation,
  mutation: OfferUsageMutation,
) {
  const next = offerUsageSchema.parse(mutation.next);
  const expected =
    mutation.expected === undefined
      ? undefined
      : offerUsageSchema.parse(mutation.expected);
  const owner =
    next.state === "unused" ? next.released.operationId : next.operationId;
  if (
    !operation.target.offer ||
    next.guildId !== operation.guildId ||
    next.mode !== operation.mode ||
    next.offerId !== operation.target.offer.id ||
    owner !== operation.operationId
  )
    throw new Error("Plan change offer scope mismatch");
  assertUsageTransition(next, expected);
  assertSettlement(next, expected);
  if (
    next.state !== "unused" &&
    !isDeepStrictEqual(next.terms, operation.target.offer.terms)
  )
    throw new Error("Plan change reservation terms mismatch");
  assertChangeOfferResult(operation, next, mutation);
  return { next, expected, authority: mutation.authority };
}

function assertFrozenChangeTerms(
  next: BillingChangeOperation,
  previous: BillingChangeOperation,
) {
  const {
    revision: oldRevision,
    quote: oldQuote,
    draftInvoiceId: oldDraft,
    ...oldBase
  } = base.parse(previous);
  const {
    revision: newRevision,
    quote: newQuote,
    draftInvoiceId: newDraft,
    ...newBase
  } = base.parse(next);
  if (
    (oldDraft !== newDraft &&
      (previous.state !== "preparing" || oldDraft !== null)) ||
    !isDeepStrictEqual(oldBase, newBase) ||
    (previous.state !== "preparing" && !isDeepStrictEqual(oldQuote, newQuote))
  )
    throw new Error("Frozen plan change terms cannot change");
  void oldRevision;
  void newRevision;
}

function assertChangeOfferResult(
  operation: BillingChangeOperation,
  next: ReturnType<typeof offerUsageSchema.parse>,
  mutation: OfferUsageMutation,
) {
  if (
    mutation.authority &&
    (!operation.target.offer ||
      !isDeepStrictEqual(mutation.authority, operation.target.offer.authority))
  )
    throw new Error("Plan change history authority mismatch");
  if (
    (next.state === "reserved" && operation.state !== "preparing") ||
    (next.state === "used" && operation.state !== "succeeded") ||
    (next.state === "unused" && operation.state !== "canceled")
  )
    throw new Error("Offer result does not match plan change");
  if (next.state === "reserved" && !mutation.authority)
    throw new Error("Fresh plan change offer requires history authority");
}
