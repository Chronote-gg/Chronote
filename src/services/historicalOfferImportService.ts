import type { HistoricalOfferBatch } from "./historicalOfferHistory";
import { createHash } from "node:crypto";
import type { ECSClient } from "@aws-sdk/client-ecs";
import type { StripeClient } from "../types/stripe";
import type { OfferUsage, IntroOfferId } from "../types/offerUsage";
import { historicalOfferImportSchema } from "../types/historicalOfferImport";
import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import { getHistoricalOfferImportRepository } from "../repositories/historicalOfferImportRepository";
import { getHistoryWriterBoundaryRepository } from "../repositories/historyWriterBoundaryRepository";
import { getPurchaseRepository } from "../repositories/purchaseAttemptRepository";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { scanHistoricalOffers } from "./historicalOfferScan";
import {
  assessHistoricalOfferHistory,
  type HistoricalOfferAssessment,
} from "./historicalOfferHistory";
import { verifyLedgerWriterDeployment } from "./ledgerWriterDeployment";
import type { HistoricalOfferScope } from "./historicalOfferEvidence";
import type { HistoryWriterBoundary } from "../types/historyWriterBoundary";

type CoverageReferences = {
  currentRevision?: string;
  proposedRevision?: string;
  boundaryRevision?: string;
  usageRevision?: string;
};
type AssessedReference = {
  invoiceId: string;
  kind: string;
  offerId?: IntroOfferId | null;
  originalOperationId?: string;
  subscriptionId?: string;
  originalInvoiceId?: string;
};
export type HistoricalImportOutcome = {
  offerId: IntroOfferId;
  coverage: CoverageReferences;
  state:
    "used" | "unused" | "unresolved" | "already_used" | "requires_recovery";
  write: "dry_run" | "applied" | "unchanged";
};
export async function importHistoricalOffers(input: {
  stripe: StripeClient;
  ecs: ECSClient;
  scope: HistoricalOfferScope;
  apply?: boolean;
  maxPages?: number;
}): Promise<{
  scope: HistoricalOfferScope;
  runId: string;
  assessedReferences: AssessedReference[];
  unresolved: {
    invoices: Extract<
      HistoricalOfferBatch["entries"][number]["evidence"],
      { kind: "unresolved" }
    >[];
    checkouts: NonNullable<HistoricalOfferBatch["checkoutEvidence"]>;
  };
  outcomes: HistoricalImportOutcome[];
  unresolvedInvoices: number;
  unresolvedCheckouts: number;
}> {
  const batch = await scanHistoricalOffers(input);
  const boundary = await getHistoryWriterBoundaryRepository().get(
    batch.scope.accountId,
    batch.scope.mode,
  );
  if (boundary) {
    const { clusterArn, serviceArn, containerName, imageDigest } =
      boundary.deployment;
    await verifyLedgerWriterDeployment(input.ecs, {
      clusterArn,
      serviceArn,
      containerName,
      imageDigest,
    });
    if (
      boundary.cutoverAt <= batch.scope.createdBefore * 1000 &&
      batch.enumeration === "complete" &&
      !batch.entries.some((entry) => entry.evidence.kind === "unresolved") &&
      !batch.checkoutEvidence?.length
    )
      batch.catchUp = "complete";
  }
  const assessment = assessHistoricalOfferHistory(batch);
  const outcomes: HistoricalImportOutcome[] = [];
  for (const [offerId, result] of [
    ["basic_intro_v1", assessment.monthly],
    ["basic_annual_intro_v1", assessment.annual],
  ] as const) {
    const outcome = await importOffer(
      input,
      batch.scope,
      batch.runId,
      batch.enumeration,
      batch.catchUp,
      boundary,
      offerId,
      result,
    );
    outcomes.push(outcome);
  }
  return {
    scope: batch.scope,
    runId: batch.runId,
    assessedReferences: batch.entries.map(assessedReference),
    unresolved: {
      invoices: batch.entries.flatMap((entry) =>
        entry.evidence.kind === "unresolved" ? [entry.evidence] : [],
      ),
      checkouts: batch.checkoutEvidence ?? [],
    },
    outcomes,
    unresolvedInvoices: batch.entries.filter(
      (entry) => entry.evidence.kind === "unresolved",
    ).length,
    unresolvedCheckouts: batch.checkoutEvidence?.length ?? 0,
  };
}
async function importOffer(
  input: { apply?: boolean },
  scope: HistoricalOfferScope,
  runId: string,
  enumeration: "complete" | "incomplete",
  catchUp: "complete" | "pending",
  boundary: HistoryWriterBoundary | undefined,
  offerId: IntroOfferId,
  result: HistoricalOfferAssessment,
): Promise<HistoricalImportOutcome> {
  const usageRepo = getOfferUsageRepository();
  const repo = getHistoricalOfferImportRepository();
  const [usageExpected, expected, operation, pointer] = await Promise.all([
    usageRepo.get(scope.guildId, offerId, scope.mode),
    repo.get(scope.guildId, offerId, scope.mode, scope.accountId),
    getPurchaseRepository().get(scope.guildId),
    getSubscriptionRepository().get(scope.guildId),
  ]);
  const coverage: CoverageReferences = {
    currentRevision: expected?.revision,
    boundaryRevision: boundary?.revision,
    usageRevision: usageExpected?.revision,
  };
  if (usageExpected?.state === "used")
    return { offerId, coverage, state: "already_used", write: "unchanged" };
  if (usageExpected?.state === "reserved")
    return {
      offerId,
      coverage,
      state: "requires_recovery",
      write: "unchanged",
    };
  const state = result.kind;
  const verifiedAt = Date.now();
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        scope,
        offerId,
        state,
        invoiceId: result.kind === "used" ? result.evidence.invoiceId : null,
        boundary: boundary?.revision,
      }),
    )
    .digest("hex");
  coverage.proposedRevision = revision;
  if (expected?.revision === revision)
    return { offerId, coverage, state, write: "unchanged" };
  const next = historicalOfferImportSchema.parse({
    ...scope,
    offerId,
    revision,
    runId,
    verifiedAt,
    enumeration,
    catchUp,
    state,
    ...(state === "unused"
      ? { writerBoundaryRevision: boundary?.revision }
      : {}),
    ...(result.kind === "used"
      ? { sourceInvoiceId: result.evidence.invoiceId }
      : {}),
  });
  const usageNext =
    result.kind === "used"
      ? importedUsage(scope, offerId, result, revision)
      : undefined;
  if (
    input.apply &&
    !(await repo.compareAndWrite({
      next,
      expected,
      usageNext,
      usageExpected,
      operation,
      pointer,
      boundary,
    }))
  )
    throw new Error("Historical import state changed; re-scan before applying");
  return {
    offerId,
    coverage,
    state: next.state,
    write: input.apply ? "applied" : "dry_run",
  };
}
function importedUsage(
  scope: HistoricalOfferScope,
  offerId: IntroOfferId,
  result: Extract<HistoricalOfferAssessment, { kind: "used" }>,
  revision: string,
): OfferUsage {
  const source = result.evidence;
  return {
    guildId: scope.guildId,
    mode: scope.mode,
    offerId,
    revision,
    state: "used",
    operationId: source.originalOperationId,
    reservedAt: source.createdAt,
    usedAt: source.settlement.settledAt,
    terms: source.terms,
    settlement: source.settlement,
  };
}

function assessedReference(
  entry: HistoricalOfferBatch["entries"][number],
): AssessedReference {
  const evidence = entry.evidence;
  const base = { invoiceId: entry.invoiceId, kind: evidence.kind };
  if (evidence.kind === "ordinary") return base;
  if (evidence.kind === "covered_cycle")
    return {
      ...base,
      offerId: evidence.offerId,
      originalInvoiceId: evidence.originalInvoiceId,
    };
  if (evidence.kind === "unresolved")
    return { ...base, offerId: evidence.offerId };
  return {
    ...base,
    offerId: evidence.offerId,
    originalOperationId: evidence.originalOperationId,
    subscriptionId: evidence.subscriptionId,
  };
}
