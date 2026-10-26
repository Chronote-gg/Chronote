import { historicalOfferImportKey } from "../types/historicalOfferImport";
import { historyWriterBoundaryKey } from "../types/historyWriterBoundary";
import type { IntroOfferAuthority } from "../types/introOfferAuthority";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import { readOfferUsage, compareAndWriteOfferUsage } from "../db";
import {
  offerUsageKey,
  parseOfferUsageChange,
  type IntroOfferId,
  type ProviderMode,
  type OfferUsage,
  type OfferUsageWrite,
} from "../types/offerUsage";

export const getOfferUsageRepository = () => ({
  async get(
    guildId: string,
    offerId: IntroOfferId,
    mode: ProviderMode,
  ): Promise<OfferUsage | undefined> {
    const key = offerUsageKey(guildId, offerId, mode);
    return config.mock.enabled
      ? structuredClone(getMockStore().offerUsages.get(key))
      : readOfferUsage(guildId, offerId, mode);
  },
  async compareAndWrite(input: OfferUsageWrite): Promise<boolean> {
    const { next, expected, authority } = parseOfferUsageChange(input);
    if (!config.mock.enabled) return compareAndWriteOfferUsage(input);
    const store = getMockStore();
    const key = offerUsageKey(next.guildId, next.offerId, next.mode);
    const current = store.offerUsages.get(key);
    const operation = store.purchaseAttempts.get(next.guildId);
    const pointer = store.subscriptions.get(next.guildId);
    if (
      current?.revision !== expected?.revision ||
      operation?.revision !== input.operation.revision ||
      operation?.attemptId !== input.operation.attemptId ||
      operation?.mode !== next.mode ||
      Boolean(pointer) !== Boolean(input.pointer) ||
      pointer?.stripeSubscriptionId !== input.pointer?.stripeSubscriptionId ||
      pointer?.stripeSyncRevision !== input.pointer?.stripeSyncRevision
    )
      return false;
    if (authority && !matchesMockOfferAuthority(authority)) return false;
    store.offerUsages.set(key, structuredClone(next));
    return true;
  },
});

export function matchesMockOfferAuthority(
  authority: IntroOfferAuthority,
): boolean {
  const store = getMockStore();
  const coverage = store.historicalOfferImports.get(
    historicalOfferImportKey(
      authority.guildId,
      authority.offerId,
      authority.mode,
      authority.accountId,
    ),
  );
  const boundary = store.historyWriterBoundaries.get(
    historyWriterBoundaryKey(authority.accountId, authority.mode),
  );
  return (
    coverage?.state === "unused" &&
    coverage.revision === authority.coverageRevision &&
    coverage.writerBoundaryRevision === authority.boundaryRevision &&
    boundary?.state === "verified" &&
    boundary.revision === authority.boundaryRevision &&
    boundary.deployment.imageDigest === authority.writerImageDigest
  );
}
