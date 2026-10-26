import { isDeepStrictEqual } from "node:util";
import { historicalOfferScopeSchema } from "./historicalOfferEvidence";
import type {
  HistoricalOfferEvidence,
  HistoricalOfferScope,
} from "./historicalOfferEvidence";
import type { IntroOfferId } from "../types/offerUsage";

export type HistoricalCheckoutEvidence = {
  kind: "unresolved";
  sessionId: string;
  offerId: IntroOfferId | null;
};
export type HistoricalOfferBatch = {
  scope: HistoricalOfferScope;
  runId: string;
  enumeration: "complete" | "incomplete";
  catchUp: "complete" | "pending";
  checkoutEvidence?: HistoricalCheckoutEvidence[];
  entries: Array<{
    scope: HistoricalOfferScope;
    invoiceId: string;
    evidence: HistoricalOfferEvidence;
  }>;
};
type Settled = Extract<HistoricalOfferEvidence, { kind: "settled" }>;
export type HistoricalOfferAssessment =
  | { kind: "used"; evidence: Settled }
  | { kind: "unused" }
  | { kind: "unresolved" };
export type HistoricalOfferHistory = {
  monthly: HistoricalOfferAssessment;
  annual: HistoricalOfferAssessment;
};
// Called only after provider account verification and invoice assessment. This
// does not establish scan completion or allow a dry-run report to authorize writes.
export function assessHistoricalOfferHistory(
  batch: HistoricalOfferBatch,
): HistoricalOfferHistory {
  historicalOfferScopeSchema.parse(batch.scope);
  if (!batch.runId) throw new Error("Historical scan identity is required");
  const seen = new Set<string>();
  for (const entry of batch.entries) {
    historicalOfferScopeSchema.parse(entry.scope);
    if (
      !isDeepStrictEqual(entry.scope, batch.scope) ||
      !entry.invoiceId ||
      seen.has(entry.invoiceId)
    )
      throw new Error("Historical evidence scope or identity mismatch");
    seen.add(entry.invoiceId);
    if (
      entry.evidence.kind !== "ordinary" &&
      entry.evidence.invoiceId !== entry.invoiceId
    )
      throw new Error("Historical evidence invoice mismatch");
  }
  return {
    monthly: assessOffer(batch, "basic_intro_v1"),
    annual: assessOffer(batch, "basic_annual_intro_v1"),
  };
}
function assessOffer(
  batch: HistoricalOfferBatch,
  offerId: IntroOfferId,
): HistoricalOfferAssessment {
  const paid = batch.entries.flatMap(({ evidence }) =>
    evidence.kind === "settled" && evidence.offerId === offerId
      ? [evidence]
      : [],
  );
  paid.sort(
    (a, b) =>
      a.settlement.settledAt - b.settlement.settledAt ||
      a.createdAt - b.createdAt ||
      a.invoiceId.localeCompare(b.invoiceId),
  );
  if (paid[0]) return { kind: "used", evidence: paid[0] };
  if (batch.enumeration !== "complete" || batch.catchUp !== "complete")
    return { kind: "unresolved" };
  const ambiguous = batch.entries.some(
    ({ evidence }) =>
      evidence.kind === "unresolved" &&
      (evidence.offerId === null || evidence.offerId === offerId),
  );
  const pendingCheckout = batch.checkoutEvidence?.some(
    (evidence) => evidence.offerId === null || evidence.offerId === offerId,
  );
  return ambiguous || pendingCheckout
    ? { kind: "unresolved" }
    : { kind: "unused" };
}
