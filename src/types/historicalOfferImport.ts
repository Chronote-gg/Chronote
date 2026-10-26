import {
  historyWriterBoundarySchema,
  type HistoryWriterBoundary,
} from "./historyWriterBoundary";
import { z } from "zod";
import {
  offerUsageSchema,
  type OfferUsage,
  type ProviderMode,
  type IntroOfferId,
} from "./offerUsage";
import type { PurchaseAttempt } from "./purchase";
import type { GuildSubscription } from "./db";
const nonempty = z.string().min(1);
const base = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  mode: z.enum(["live", "test"]),
  accountId: nonempty,
  offerId: z.enum(["basic_intro_v1", "basic_annual_intro_v1"]),
  revision: nonempty,
  runId: nonempty,
  createdBefore: z.number().int().nonnegative(),
  verifiedAt: z.number().int().nonnegative(),
  enumeration: z.enum(["complete", "incomplete"]),
  catchUp: z.enum(["complete", "pending"]),
  writerBoundaryRevision: nonempty.optional(),
});
export const historicalOfferImportSchema = z.discriminatedUnion("state", [
  base.extend({ state: z.literal("used"), sourceInvoiceId: nonempty }).strict(),
  base
    .extend({
      state: z.literal("unused"),
      enumeration: z.literal("complete"),
      catchUp: z.literal("complete"),
      writerBoundaryRevision: nonempty,
    })
    .strict(),
  base.extend({ state: z.literal("unresolved") }).strict(),
]);
export type HistoricalOfferImport = z.infer<typeof historicalOfferImportSchema>;
export type HistoricalOfferImportWrite = {
  next: unknown;
  expected: unknown;
  usageNext: unknown;
  usageExpected: unknown;
  pointer: GuildSubscription | undefined;
  operation: PurchaseAttempt | undefined;
  boundary?: HistoryWriterBoundary;
};
export function historicalOfferImportKey(
  guildId: string,
  offerId: IntroOfferId,
  mode: ProviderMode,
  accountId: string,
): string {
  base
    .pick({ guildId: true, offerId: true, mode: true, accountId: true })
    .parse({ guildId, offerId, mode, accountId });
  return `OFFER_HISTORY#${mode}#${encodeURIComponent(accountId)}#${guildId}#${offerId}`;
}
function key(record: HistoricalOfferImport) {
  return historicalOfferImportKey(
    record.guildId,
    record.offerId,
    record.mode,
    record.accountId,
  );
}
export function parseHistoricalOfferImportWrite(
  input: HistoricalOfferImportWrite,
) {
  const next = historicalOfferImportSchema.parse(input.next);
  validateImportCoverage(next, input.boundary);
  const expected =
    input.expected === undefined
      ? undefined
      : historicalOfferImportSchema.parse(input.expected);
  const usageNext =
    input.usageNext === undefined
      ? undefined
      : offerUsageSchema.parse(input.usageNext);
  const usageExpected =
    input.usageExpected === undefined
      ? undefined
      : offerUsageSchema.parse(input.usageExpected);
  if (
    (input.pointer && input.pointer.guildId !== next.guildId) ||
    (input.operation && input.operation.guildId !== next.guildId)
  )
    throw new Error("Historical import control scope mismatch");
  validateImportRevision(next, expected);
  validateImportUsages(next, usageNext, usageExpected);
  return { next, expected, usageNext, usageExpected };
}
function validateImportedUsage(
  next: HistoricalOfferImport,
  usage: OfferUsage,
  expected: OfferUsage | undefined,
) {
  if (
    next.state !== "used" ||
    usage.state !== "used" ||
    usage.writerVersion !== undefined ||
    usage.writerRuntime !== undefined ||
    usage.settlement.invoiceId !== next.sourceInvoiceId ||
    usage.terms.priceId !== usage.settlement.priceId ||
    usage.terms.interval !==
      (next.offerId === "basic_intro_v1" ? "month" : "year") ||
    usage.usedAt < usage.reservedAt ||
    usage.settlement.settledAt < Math.floor(usage.reservedAt / 1000) * 1000 ||
    usage.reservedAt > next.createdBefore * 1000 ||
    usage.settlement.settledAt > next.verifiedAt ||
    (expected && usage.revision === expected.revision)
  )
    throw new Error("Historical import settlement mismatch");
}

function validateImportCoverage(
  next: HistoricalOfferImport,
  boundaryInput: unknown,
) {
  if (next.verifiedAt < next.createdBefore * 1000)
    throw new Error("Historical cutoff is newer than its verification");
  if (next.state === "unused") {
    const boundary = historyWriterBoundarySchema.parse(boundaryInput);
    if (
      boundary.accountId !== next.accountId ||
      boundary.mode !== next.mode ||
      boundary.revision !== next.writerBoundaryRevision ||
      boundary.cutoverAt > next.createdBefore * 1000 ||
      boundary.verifiedAt > next.verifiedAt
    )
      throw new Error("Historical coverage writer boundary mismatch");
  }
}
function validateImportRevision(
  next: HistoricalOfferImport,
  expected: HistoricalOfferImport | undefined,
) {
  if (
    expected &&
    (key(expected) !== key(next) ||
      expected.revision === next.revision ||
      next.createdBefore < expected.createdBefore ||
      next.verifiedAt < expected.verifiedAt ||
      (expected.state === "used" && next.state !== "used"))
  )
    throw new Error("Invalid historical import revision");
}
function validateImportUsages(
  next: HistoricalOfferImport,
  usageNext: OfferUsage | undefined,
  usageExpected: OfferUsage | undefined,
) {
  for (const usage of [usageNext, usageExpected])
    if (
      usage &&
      (usage.guildId !== next.guildId ||
        usage.mode !== next.mode ||
        usage.offerId !== next.offerId)
    )
      throw new Error("Historical import offer scope mismatch");
  if (usageExpected?.state === "reserved")
    throw new Error(
      "Historical reservation requires original operation recovery",
    );
  if (usageExpected?.state === "used" && (usageNext || next.state !== "used"))
    throw new Error("Used history is immutable");
  if (usageNext) validateImportedUsage(next, usageNext, usageExpected);
  else if (next.state === "used" && usageExpected?.state !== "used")
    throw new Error("Imported use requires paid evidence");
}
