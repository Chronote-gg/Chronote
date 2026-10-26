import {
  historyWriterBoundaryKey,
  HISTORY_WRITER_VERSION,
} from "../types/historyWriterBoundary";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import {
  readHistoricalOfferImport,
  compareAndWriteHistoricalOfferImport,
} from "../db";
import {
  historicalOfferImportKey,
  parseHistoricalOfferImportWrite,
  type HistoricalOfferImport,
  type HistoricalOfferImportWrite,
} from "../types/historicalOfferImport";
import {
  offerUsageKey,
  type IntroOfferId,
  type ProviderMode,
} from "../types/offerUsage";
export const getHistoricalOfferImportRepository = () => ({
  async get(
    guildId: string,
    offerId: IntroOfferId,
    mode: ProviderMode,
    accountId: string,
  ): Promise<HistoricalOfferImport | undefined> {
    const key = historicalOfferImportKey(guildId, offerId, mode, accountId);
    return config.mock.enabled
      ? structuredClone(getMockStore().historicalOfferImports.get(key))
      : readHistoricalOfferImport(guildId, offerId, mode, accountId);
  },
  async compareAndWrite(input: HistoricalOfferImportWrite): Promise<boolean> {
    const { next, expected, usageNext, usageExpected } =
      parseHistoricalOfferImportWrite(input);
    if (!config.mock.enabled)
      return compareAndWriteHistoricalOfferImport(input);
    const store = getMockStore();
    const key = historicalOfferImportKey(
      next.guildId,
      next.offerId,
      next.mode,
      next.accountId,
    );
    const usageKey = offerUsageKey(next.guildId, next.offerId, next.mode);
    const operation = store.purchaseAttempts.get(next.guildId);
    const pointer = store.subscriptions.get(next.guildId);
    if (
      store.historicalOfferImports.get(key)?.revision !== expected?.revision ||
      store.offerUsages.get(usageKey)?.revision !== usageExpected?.revision ||
      operation?.revision !== input.operation?.revision ||
      operation?.attemptId !== input.operation?.attemptId ||
      operation?.mode !== input.operation?.mode ||
      Boolean(pointer) !== Boolean(input.pointer) ||
      pointer?.stripeSubscriptionId !== input.pointer?.stripeSubscriptionId ||
      pointer?.stripeSyncRevision !== input.pointer?.stripeSyncRevision
    )
      return false;
    if (!matchesStoredBoundary(next)) return false;
    if (usageNext) store.offerUsages.set(usageKey, structuredClone(usageNext));
    store.historicalOfferImports.set(key, structuredClone(next));
    return true;
  },
});

function matchesStoredBoundary(next: HistoricalOfferImport): boolean {
  if (next.state !== "unused") return true;
  const boundary = getMockStore().historyWriterBoundaries.get(
    historyWriterBoundaryKey(next.accountId, next.mode),
  );
  return Boolean(
    boundary &&
    boundary.revision === next.writerBoundaryRevision &&
    boundary.accountId === next.accountId &&
    boundary.mode === next.mode &&
    boundary.state === "verified" &&
    boundary.writerVersion === HISTORY_WRITER_VERSION &&
    boundary.cutoverAt <= next.createdBefore * 1000 &&
    boundary.verifiedAt <= next.verifiedAt,
  );
}
