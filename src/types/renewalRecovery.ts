import { z } from "zod";
import { ledgerWriterRuntimeSchema } from "./ledgerWriterRuntime";
export const RENEWAL_RECOVERY_WRITER_VERSION = "renewal-grace-v1";
import { isDeepStrictEqual } from "node:util";

const seconds = z.number().int().nonnegative();
const id = z.string().min(1);
export const RENEWAL_GRACE_SECONDS = 172800;
export const RENEWAL_RECOVERY_DUE_INDEX = "RenewalRecoveryDueIndex";
export const renewalGraceDeadline = (finalizedAt: number): number =>
  seconds.parse(finalizedAt) + RENEWAL_GRACE_SECONDS;
const paid = z
  .object({
    invoiceId: id,
    priceId: id,
    tier: z.enum(["basic", "pro"]),
    interval: z.enum(["month", "year"]),
    periodStart: seconds,
    periodEnd: seconds,
  })
  .strict()
  .refine((value) => value.periodEnd > value.periodStart);
const base = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/),
    subscriptionId: id,
    customerId: id,
    payerId: id,
    mode: z.enum(["test", "live"]),
    revision: id,
    paid,
    scheduledOperationId: id.nullable(),
    enforcementAccepted: z.boolean(),
    writerVersion: z.literal(RENEWAL_RECOVERY_WRITER_VERSION).optional(),
    writerRuntime: ledgerWriterRuntimeSchema.optional(),
  })
  .strict();
const bound = base.extend({
  invoice: z
    .object({
      id,
      lineId: id,
      finalizedAt: seconds,
      periodStart: seconds,
      periodEnd: seconds,
    })
    .strict(),
  endsAt: seconds,
});
export const renewalRecoveryReceiptsSchema = z
  .object({
    creditNoteId: id.nullable(),
    refundIds: z.array(id),
    canceled: z.boolean(),
    collectionRestored: z.boolean().default(false),
    collectionToRestore: z.array(id).nullable().default(null),
    unrelatedInvoices: z
      .array(z.object({ id, autoAdvance: z.boolean() }).strict())
      .default([]),
  })
  .strict();
export const renewalRecoverySchema = z
  .discriminatedUnion("state", [
    base
      .extend({ state: z.literal("watching"), nextCheckAt: seconds })
      .strict(),
    base.extend({ state: z.literal("ended") }).strict(),
    bound.extend({ state: z.literal("grace"), nextCheckAt: seconds }).strict(),
    bound
      .extend({
        state: z.literal("canceling"),
        nextCheckAt: seconds,
        reason: z.enum(["payer", "expired"]),
        receipts: renewalRecoveryReceiptsSchema,
      })
      .strict(),
    bound
      .extend({
        state: z.literal("paid"),
        projection: z.discriminatedUnion("state", [
          z
            .object({ state: z.literal("pending"), nextCheckAt: seconds })
            .strict(),
          z.object({ state: z.literal("complete") }).strict(),
        ]),
      })
      .strict(),
    bound
      .extend({
        state: z.literal("superseded"),
        replacementPaid: paid,
        receipts: renewalRecoveryReceiptsSchema,
        projection: z.discriminatedUnion("state", [
          z
            .object({ state: z.literal("pending"), nextCheckAt: seconds })
            .strict(),
          z.object({ state: z.literal("complete") }).strict(),
        ]),
      })
      .strict(),
    bound
      .extend({
        state: z.literal("canceled"),
        reason: z.enum(["payer", "expired"]),
        receipts: renewalRecoveryReceiptsSchema,
      })
      .strict(),
  ])
  .superRefine((record, context) => {
    if (
      record.state === "superseded" &&
      (!record.receipts.collectionRestored ||
        record.replacementPaid.invoiceId === record.invoice.id ||
        record.replacementPaid.periodStart < record.invoice.periodStart)
    )
      context.addIssue({
        code: "custom",
        message:
          "Superseded recovery requires verified later paid coverage and collection restoration",
      });
    if (
      record.state === "canceled" &&
      !(
        record.receipts.canceled &&
        record.receipts.collectionRestored &&
        record.receipts.collectionToRestore !== null
      )
    )
      context.addIssue({
        code: "custom",
        message: "Renewal cancellation requires complete native proof",
      });
    if (
      record.state !== "watching" &&
      record.state !== "ended" &&
      record.endsAt !== renewalGraceDeadline(record.invoice.finalizedAt)
    )
      context.addIssue({
        code: "custom",
        message: "Renewal grace deadline must match provider finalization",
      });
  });
export type RenewalRecovery = z.infer<typeof renewalRecoverySchema>;
export type RenewalRecoveryView =
  | { status: "none" }
  | {
      status: "settlement_pending" | "grace" | "reconciling" | "canceled";
      priorTier: "basic" | "pro";
      selectedTier: "free" | "basic" | "pro" | null;
      selectedInterval: "month" | "year" | null;
      scheduledChange: boolean;
      endsAt: string | null;
      amountDue: number | null;
      currency: string | null;
      paymentUrl: string | null;
      canManage: boolean;
    };
export type RenewalRecoveryReceipts = z.infer<
  typeof renewalRecoveryReceiptsSchema
>;
export const renewalRecoveryKey = (
  record: Pick<RenewalRecovery, "guildId" | "subscriptionId"> & {
    paid: Pick<RenewalRecovery["paid"], "periodEnd">;
  },
) =>
  `RENEWAL_RECOVERY#${record.guildId}#${record.subscriptionId}#${record.paid.periodEnd}`;
export const renewalRecoveryCurrentKey = (guildId: string) =>
  `RENEWAL_RECOVERY_CURRENT#${guildId}`;
export const renewalRecoveryPointerSchema = z
  .object({ key: id, revision: id, blocking: z.boolean() })
  .strict();
export type RenewalRecoveryPointer = z.infer<
  typeof renewalRecoveryPointerSchema
>;
export const isRenewalRecoveryBlocking = (record: RenewalRecovery) =>
  record.enforcementAccepted &&
  (record.state === "grace" ||
    record.state === "canceling" ||
    ((record.state === "paid" || record.state === "superseded") &&
      record.projection.state === "pending"));
export function isRenewalCancellationComplete(
  record: RenewalRecovery | undefined,
): record is Extract<RenewalRecovery, { state: "canceling" | "canceled" }> {
  return Boolean(
    record &&
    (record.state === "canceling" || record.state === "canceled") &&
    record.receipts.canceled &&
    record.receipts.collectionRestored &&
    record.receipts.collectionToRestore !== null,
  );
}
export const renewalRecoveryNextCheck = (
  record: RenewalRecovery,
): number | undefined =>
  "nextCheckAt" in record
    ? record.nextCheckAt
    : (record.state === "paid" || record.state === "superseded") &&
        record.projection.state === "pending"
      ? record.projection.nextCheckAt
      : undefined;
const transitions: Record<
  RenewalRecovery["state"],
  RenewalRecovery["state"][]
> = {
  watching: ["watching", "grace", "paid", "ended"],
  ended: [],
  grace: ["grace", "canceling", "paid"],
  canceling: ["canceling", "paid", "canceled", "superseded"],
  superseded: ["superseded"],
  paid: ["paid"],
  canceled: [],
};
export function assertRenewalRecoveryTransition(
  next: RenewalRecovery,
  previous: RenewalRecovery,
): void {
  next = renewalRecoverySchema.parse(next);
  previous = renewalRecoverySchema.parse(previous);
  if (
    next.revision === previous.revision ||
    !transitions[previous.state].includes(next.state)
  )
    throw new Error("Invalid renewal recovery transition");
  assertProjectionTransition(next, previous);
  for (const field of [
    "guildId",
    "subscriptionId",
    "customerId",
    "payerId",
    "mode",
  ] as const)
    if (!isDeepStrictEqual(next[field], previous[field]))
      throw new Error("Renewal paid source is immutable");
  const replacingWatch = canReplaceUnboundWatch(next, previous);
  if (
    !replacingWatch &&
    (["paid", "writerVersion", "writerRuntime"] as const).some(
      (field) => !isDeepStrictEqual(next[field], previous[field]),
    )
  )
    throw new Error("Renewal paid source is immutable");
  if (previous.enforcementAccepted && !next.enforcementAccepted)
    throw new Error("Accepted renewal recovery cannot be disabled");
  if (previous.state === "canceling") assertRecoveryReceipts(next, previous);
  assertBoundRenewalRecovery(next, previous);
}
function assertProjectionTransition(
  next: RenewalRecovery,
  previous: RenewalRecovery,
): void {
  if (
    (previous.state === "paid" || previous.state === "superseded") &&
    (previous.projection.state !== "pending" ||
      next.state !== previous.state ||
      next.projection.state !== "complete")
  )
    throw new Error("Paid renewal requires projection reconciliation");
  if (
    previous.state === "superseded" &&
    next.state === "superseded" &&
    !isDeepStrictEqual(previous.replacementPaid, next.replacementPaid)
  )
    throw new Error("Replacement paid evidence is immutable");
}
function canReplaceUnboundWatch(
  next: RenewalRecovery,
  previous: RenewalRecovery,
): boolean {
  return (
    previous.state === "watching" &&
    next.state === "watching" &&
    !previous.enforcementAccepted &&
    !next.enforcementAccepted &&
    previous.paid.periodEnd === next.paid.periodEnd &&
    next.paid.periodStart >= previous.paid.periodStart &&
    (isDeepStrictEqual(next.paid, previous.paid) ||
      next.paid.invoiceId !== previous.paid.invoiceId)
  );
}
function assertBoundRenewalRecovery(
  next: RenewalRecovery,
  previous: RenewalRecovery,
): void {
  if (previous.state === "watching" || previous.state === "ended") return;
  if (next.state === "watching" || next.state === "ended")
    throw new Error("Bound renewal cannot become a watch");
  if (
    !isDeepStrictEqual(next.invoice, previous.invoice) ||
    next.scheduledOperationId !== previous.scheduledOperationId ||
    next.endsAt !== previous.endsAt
  )
    throw new Error("Bound renewal invoice and deadline are immutable");
}

function assertRecoveryReceipts(
  next: RenewalRecovery,
  previous: Extract<RenewalRecovery, { state: "canceling" }>,
): void {
  if (next.state === "paid") {
    if (previous.receipts.creditNoteId || previous.receipts.canceled)
      throw new Error("Compensated renewal cannot become paid");
    return;
  }
  if (
    next.state !== "canceling" &&
    next.state !== "canceled" &&
    next.state !== "superseded"
  )
    throw new Error("Invalid recovery receipt transition");
  const before = previous.receipts;
  const after = next.receipts;
  assertNativeReceipts(before, after);
  assertCollectionReceipts(before, after);
  if (before.refundIds.some((id) => !after.refundIds.includes(id)))
    throw new Error("Refund receipts cannot be removed");
  if (next.state === "canceled" && !isRenewalCancellationComplete(next))
    throw new Error("Renewal cancellation requires complete native proof");
}
function assertCollectionReceipts(
  before: RenewalRecoveryReceipts,
  after: RenewalRecoveryReceipts,
): void {
  if (
    before.unrelatedInvoices.some(
      (invoice) =>
        !after.unrelatedInvoices.some((next) =>
          isDeepStrictEqual(invoice, next),
        ),
    )
  )
    throw new Error("Collection snapshot is immutable");
  if (
    (before.canceled || before.collectionRestored) &&
    before.collectionToRestore !== null &&
    !isDeepStrictEqual(before.collectionToRestore, after.collectionToRestore)
  )
    throw new Error("Collection restoration targets are immutable");
  if (
    after.collectionToRestore?.some(
      (id) =>
        !after.unrelatedInvoices.some(
          (invoice) => invoice.id === id && invoice.autoAdvance,
        ),
    )
  )
    throw new Error("Collection restoration must match its original snapshot");
}
function assertNativeReceipts(
  before: RenewalRecoveryReceipts,
  after: RenewalRecoveryReceipts,
): void {
  if (
    (before.creditNoteId && before.creditNoteId !== after.creditNoteId) ||
    (before.canceled && !after.canceled) ||
    (before.collectionRestored && !after.collectionRestored)
  )
    throw new Error("Bound native recovery receipts are immutable");
}
export const renewalRecoveryCursorSchema = z
  .object({
    guildId: id,
    recoveryQueue: z.enum(["test", "live"]),
    recoveryDueAt: seconds,
  })
  .strict();
export function readRenewalRecoveryCursor(cursor: string | undefined) {
  return cursor
    ? renewalRecoveryCursorSchema.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
      )
    : undefined;
}
export const writeRenewalRecoveryCursor = (
  key: z.infer<typeof renewalRecoveryCursorSchema>,
) => Buffer.from(JSON.stringify(key)).toString("base64url");
