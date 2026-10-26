import { classifyChangeHistory } from "./billingChangeHistory";
import { assertHistoricalProviderPage } from "./historicalProviderPage";
import { scanHistoricalCheckouts } from "./historicalCheckoutScan";
import { introOfferIdSchema } from "../types/basicIntroOffers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StripeClient, StripeInvoice } from "../types/stripe";
import {
  classifyHistoricalOfferInvoice,
  coverHistoricalOfferCycle,
  historicalOfferScopeSchema,
  type HistoricalOfferScope,
} from "./historicalOfferEvidence";
import type { HistoricalOfferBatch } from "./historicalOfferHistory";

// This scan never writes or asserts that normal writers and late payments have
// been caught up. A complete enumeration is distinct from migration coverage.
export async function scanHistoricalOffers(input: {
  stripe: StripeClient;
  scope: HistoricalOfferScope;
  maxPages?: number;
}): Promise<HistoricalOfferBatch> {
  const scope = historicalOfferScopeSchema.parse(input.scope);
  const maxPages = z
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(input.maxPages ?? 100);
  const [account, balance] = await Promise.all([
    input.stripe.accounts.retrieve(null),
    input.stripe.balance.retrieve(),
  ]);
  if (
    account.id !== scope.accountId ||
    balance.livemode !== (scope.mode === "live")
  )
    throw new Error("Historical scan provider account or mode mismatch");
  const batch: HistoricalOfferBatch = {
    scope,
    runId: randomUUID(),
    enumeration: "incomplete",
    catchUp: "pending",
    entries: [],
    checkoutEvidence: [],
  };
  const cycles = new Map<string, StripeInvoice>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await input.stripe.invoices.list({
      created: { lte: scope.createdBefore },
      limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    });
    assertHistoricalProviderPage(page);
    if (page.has_more && !page.data.length)
      throw new Error("Historical scan pagination has no continuation");
    for (const invoice of page.data) {
      assertListedInvoice(invoice, scope, seen);
      const entry = await assessScannedInvoice(
        input.stripe,
        invoice,
        scope,
        cycles,
      );
      if (entry) batch.entries.push(entry);
    }
    if (!page.has_more) {
      batch.enumeration = "complete";
      break;
    }
    cursor = page.data[page.data.length - 1].id;
  }
  coverScannedCycles(batch, cycles);
  const checkouts = await scanHistoricalCheckouts(
    input.stripe,
    batch,
    maxPages,
  );
  batch.checkoutEvidence = checkouts.evidence;
  if (!checkouts.complete) batch.enumeration = "incomplete";
  return batch;
}
function assertListedInvoice(
  invoice: StripeInvoice,
  scope: HistoricalOfferScope,
  seen: Set<string>,
) {
  if (
    !invoice.id ||
    seen.has(invoice.id) ||
    invoice.livemode !== (scope.mode === "live") ||
    !Number.isInteger(invoice.created) ||
    invoice.created < 0 ||
    invoice.created > scope.createdBefore
  )
    throw new Error(
      "Historical scan returned invalid or repeated invoice scope",
    );
  seen.add(invoice.id);
}
async function assessScannedInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice,
  scope: HistoricalOfferScope,
  cycles: Map<string, StripeInvoice>,
): Promise<HistoricalOfferBatch["entries"][number] | undefined> {
  const owner =
    invoice.parent?.subscription_details?.metadata?.guild_id ??
    invoice.metadata?.guild_id;
  const validOwner =
    historicalOfferScopeSchema.shape.guildId.safeParse(owner).success;
  if (validOwner && owner !== scope.guildId) return undefined;
  if (!validOwner)
    return {
      scope,
      invoiceId: invoice.id,
      evidence: {
        kind: "unresolved",
        invoiceId: invoice.id,
        offerId: null,
        reason: "missing_snapshot",
      },
    };
  const original = await stripe.invoices.retrieve(invoice.id, {
    expand: ["discounts.source.coupon"],
  });
  assertListedInvoice(original, scope, new Set());
  if (original.id !== invoice.id)
    throw new Error("Historical original invoice identity mismatch");
  const change = await classifyChangeHistory(original, scope);
  if (change) return { scope, invoiceId: invoice.id, evidence: change };
  return assessOriginalHistory(stripe, original, scope, cycles);
}
async function assessOriginalHistory(
  stripe: StripeClient,
  original: StripeInvoice,
  scope: HistoricalOfferScope,
  cycles: Map<string, StripeInvoice>,
): Promise<HistoricalOfferBatch["entries"][number]> {
  const invoice = original;
  const metadata = original.parent?.subscription_details?.metadata;
  const claimedOffer = introOfferIdSchema.safeParse(metadata?.intro_offer_id);
  if (
    original.billing_reason === "subscription_cycle" &&
    (metadata?.intro_offer_id || metadata?.intro_offer_coupon_id)
  ) {
    cycles.set(invoice.id, original);
    return {
      scope,
      invoiceId: invoice.id,
      evidence: {
        kind: "unresolved",
        invoiceId: invoice.id,
        offerId: claimedOffer.success ? claimedOffer.data : null,
        reason: "unsupported_identity",
      },
    };
  }
  const reference = original.lines.data[0]?.pricing?.price_details?.price;
  const priceId = typeof reference === "string" ? reference : reference?.id;
  const price =
    metadata?.intro_offer_id && priceId
      ? await stripe.prices.retrieve(priceId)
      : undefined;
  const evidence = classifyHistoricalOfferInvoice(original, price, scope);
  if (
    evidence.kind === "unpaid_void" &&
    !(await isTerminalHistoricalVoid(stripe, evidence, scope))
  )
    return {
      scope,
      invoiceId: invoice.id,
      evidence: {
        kind: "unresolved",
        invoiceId: invoice.id,
        offerId: evidence.offerId,
        reason: "unsettled",
      },
    };
  return { scope, invoiceId: invoice.id, evidence };
}

function coverScannedCycles(
  batch: HistoricalOfferBatch,
  cycles: Map<string, StripeInvoice>,
) {
  const origins = batch.entries.flatMap((entry) =>
    entry.evidence.kind === "settled" ? [entry.evidence] : [],
  );
  for (const entry of batch.entries) {
    const cycle = cycles.get(entry.invoiceId);
    if (cycle)
      entry.evidence =
        coverHistoricalOfferCycle(cycle, batch.scope, origins) ??
        entry.evidence;
  }
}

async function isTerminalHistoricalVoid(
  stripe: StripeClient,
  evidence: Extract<
    import("./historicalOfferEvidence").HistoricalOfferEvidence,
    { kind: "unpaid_void" }
  >,
  scope: HistoricalOfferScope,
): Promise<boolean> {
  const subscription = await stripe.subscriptions.retrieve(
    evidence.subscriptionId,
  );
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  if (
    subscription.id !== evidence.subscriptionId ||
    customerId !== evidence.customerId ||
    subscription.livemode !== (scope.mode === "live")
  )
    throw new Error("Historical void subscription scope mismatch");
  return (
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  );
}
