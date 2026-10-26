import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import {
  readHistoryWriterBoundary,
  compareAndWriteHistoryWriterBoundary,
  removeHistoryWriterBoundary,
} from "../db";
import {
  historyWriterBoundaryKey,
  historyWriterBoundarySchema,
  type HistoryWriterBoundary,
  validateBoundarySample,
} from "../types/historyWriterBoundary";
import type { ProviderMode } from "../types/offerUsage";
import type { PurchaseAttempt } from "../types/purchase";
export const getHistoryWriterBoundaryRepository = () => ({
  async get(
    accountId: string,
    mode: ProviderMode,
  ): Promise<HistoryWriterBoundary | undefined> {
    const key = historyWriterBoundaryKey(accountId, mode);
    const record = config.mock.enabled
      ? structuredClone(getMockStore().historyWriterBoundaries.get(key))
      : await readHistoryWriterBoundary(accountId, mode);
    return record === undefined
      ? undefined
      : historyWriterBoundarySchema.parse(record);
  },
  async compareAndWrite(
    next: HistoryWriterBoundary,
    expected: HistoryWriterBoundary | undefined,
    sample: PurchaseAttempt,
  ): Promise<boolean> {
    validateBoundarySample(next, expected, sample);
    if (!config.mock.enabled)
      return compareAndWriteHistoryWriterBoundary(next, expected, sample);
    const store = getMockStore();
    const key = historyWriterBoundaryKey(next.accountId, next.mode);
    const current = store.purchaseAttempts.get(sample.guildId);
    if (
      store.historyWriterBoundaries.get(key)?.revision !== expected?.revision ||
      current?.revision !== sample.revision ||
      current?.attemptId !== sample.attemptId ||
      current?.mode !== next.mode
    )
      return false;
    store.historyWriterBoundaries.set(key, structuredClone(next));
    return true;
  },
  async remove(expected: HistoryWriterBoundary): Promise<boolean> {
    historyWriterBoundarySchema.parse(expected);
    if (!config.mock.enabled) return removeHistoryWriterBoundary(expected);
    const store = getMockStore();
    const key = historyWriterBoundaryKey(expected.accountId, expected.mode);
    if (store.historyWriterBoundaries.get(key)?.revision !== expected.revision)
      return false;
    store.historyWriterBoundaries.delete(key);
    return true;
  },
});
