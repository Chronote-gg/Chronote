import { assertHistoricalProviderPage } from "./historicalProviderPage";
import type { StripeClient, StripeCheckoutSession } from "../types/stripe";
import type {
  HistoricalOfferBatch,
  HistoricalCheckoutEvidence,
} from "./historicalOfferHistory";
import { historicalOfferScopeSchema } from "./historicalOfferEvidence";
import { introOfferIdSchema } from "../types/basicIntroOffers";
import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import { HISTORY_WRITER_VERSION } from "../types/historyWriterBoundary";
const id = (reference: string | { id: string } | null | undefined) =>
  typeof reference === "string" ? reference : reference?.id;
export async function scanHistoricalCheckouts(
  stripe: StripeClient,
  batch: HistoricalOfferBatch,
  maxPages: number,
): Promise<{ complete: boolean; evidence: HistoricalCheckoutEvidence[] }> {
  const evidence: HistoricalCheckoutEvidence[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await stripe.checkout.sessions.list({
      created: { lte: batch.scope.createdBefore },
      limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    });
    assertHistoricalProviderPage(page);
    if (page.has_more && !page.data.length)
      throw new Error("Historical Checkout pagination has no continuation");
    for (const session of page.data) {
      assertSessionScope(session, batch, seen);
      if (isExpiredWithoutPayment(session)) continue;
      const owner = session.metadata?.guild_id;
      if (
        historicalOfferScopeSchema.shape.guildId.safeParse(owner).success &&
        owner !== batch.scope.guildId
      )
        continue;
      const offer = introOfferIdSchema.safeParse(
        session.metadata?.intro_offer_id,
      );
      if (
        owner === batch.scope.guildId &&
        (isCoveredByInvoice(session, batch) ||
          (offer.success &&
            (await isCoveredByWriter(session, batch, offer.data))))
      )
        continue;
      evidence.push({
        kind: "unresolved",
        sessionId: session.id,
        offerId:
          owner === batch.scope.guildId && offer.success ? offer.data : null,
      });
    }
    if (!page.has_more) return { complete: true, evidence };
    cursor = page.data[page.data.length - 1].id;
  }
  return { complete: false, evidence };
}
function assertSessionScope(
  session: StripeCheckoutSession,
  batch: HistoricalOfferBatch,
  seen: Set<string>,
) {
  if (
    !session.id ||
    seen.has(session.id) ||
    session.livemode !== (batch.scope.mode === "live") ||
    !Number.isInteger(session.created) ||
    session.created < 0 ||
    session.created > batch.scope.createdBefore
  )
    throw new Error("Historical Checkout scope or identity mismatch");
  seen.add(session.id);
}
function isExpiredWithoutPayment(session: StripeCheckoutSession) {
  return (
    session.status === "expired" && !session.subscription && !session.invoice
  );
}
function isCoveredByInvoice(
  session: StripeCheckoutSession,
  batch: HistoricalOfferBatch,
): boolean {
  const invoiceId = id(session.invoice);
  if (!invoiceId) return false;
  const match = batch.entries.find(
    (entry) => entry.invoiceId === invoiceId,
  )?.evidence;
  if (!match || match.kind === "unresolved" || match.kind === "covered_cycle")
    return false;
  if (match.kind === "ordinary")
    return (
      session.status === "complete" &&
      ["paid", "no_payment_required"].includes(session.payment_status) &&
      !session.metadata?.intro_offer_id
    );
  return (
    match.customerId === id(session.customer) &&
    match.subscriptionId === id(session.subscription) &&
    match.originalOperationId === session.metadata?.purchase_attempt_id &&
    match.offerId === session.metadata?.intro_offer_id
  );
}
async function isCoveredByWriter(
  session: StripeCheckoutSession,
  batch: HistoricalOfferBatch,
  offerId: "basic_intro_v1" | "basic_annual_intro_v1",
): Promise<boolean> {
  const usage = await getOfferUsageRepository().get(
    batch.scope.guildId,
    offerId,
    batch.scope.mode,
  );
  return Boolean(
    usage?.state === "used" &&
    usage.writerVersion === HISTORY_WRITER_VERSION &&
    usage.operationId === session.metadata?.purchase_attempt_id &&
    usage.settlement.invoiceId === id(session.invoice) &&
    usage.settlement.subscriptionId === id(session.subscription) &&
    usage.settlement.customerId === id(session.customer),
  );
}
