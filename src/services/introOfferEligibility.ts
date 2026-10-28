import type { IntroOfferAuthority } from "../types/introOfferAuthority";
import { getOfferUsageRepository } from "../repositories/offerUsageRepository";
import { getHistoricalOfferImportRepository } from "../repositories/historicalOfferImportRepository";
import { getHistoryWriterBoundaryRepository } from "../repositories/historyWriterBoundaryRepository";
import {
  offerUsageKey,
  type IntroOfferId,
  type ProviderMode,
} from "../types/offerUsage";
export async function readIntroOfferDecision(input: {
  guildId: string;
  accountId: string;
  mode: ProviderMode;
  offerId: IntroOfferId;
  writerImageDigest: string | undefined;
  /** A reservation held by this operation is judged as if already released. */
  releasableOperationId?: string;
}): Promise<
  | { state: "used" | "reserved" | "unresolved" }
  | { state: "unused"; authority: IntroOfferAuthority }
> {
  offerUsageKey(input.guildId, input.offerId, input.mode);
  const usage = await getOfferUsageRepository().get(
    input.guildId,
    input.offerId,
    input.mode,
  );
  if (usage?.state === "used") return { state: "used" };
  if (
    usage?.state === "reserved" &&
    usage.operationId !== input.releasableOperationId
  )
    return { state: "reserved" };
  const [coverage, boundary] = await Promise.all([
    getHistoricalOfferImportRepository().get(
      input.guildId,
      input.offerId,
      input.mode,
      input.accountId,
    ),
    getHistoryWriterBoundaryRepository().get(input.accountId, input.mode),
  ]);
  if (coverage?.state !== "unused" || !boundary || !input.writerImageDigest)
    return { state: "unresolved" };
  if (
    coverage.writerBoundaryRevision !== boundary.revision ||
    boundary.deployment.imageDigest !== input.writerImageDigest ||
    boundary.cutoverAt > coverage.createdBefore * 1000 ||
    boundary.verifiedAt > coverage.verifiedAt
  )
    return { state: "unresolved" };
  return {
    state: "unused",
    authority: {
      guildId: input.guildId,
      offerId: input.offerId,
      mode: input.mode,
      accountId: input.accountId,
      coverageRevision: coverage.revision,
      boundaryRevision: boundary.revision,
      writerImageDigest: input.writerImageDigest,
    },
  };
}

export async function readIntroOfferEligibility(
  input: Parameters<typeof readIntroOfferDecision>[0],
) {
  return (await readIntroOfferDecision(input)).state;
}
