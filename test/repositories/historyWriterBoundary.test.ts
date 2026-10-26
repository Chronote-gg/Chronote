/** @jest-environment node */
import { historyWriterBoundaryFixture } from "../fixtures/historyWriterBoundary";
import { getHistoricalOfferImportRepository } from "../../src/repositories/historicalOfferImportRepository";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { historyWriterBoundaryKey } from "../../src/types/historyWriterBoundary";
const guildId = "111111111111111111";
const boundary = historyWriterBoundaryFixture();
const coverage = {
  guildId,
  accountId: boundary.accountId,
  mode: boundary.mode,
  offerId: "basic_intro_v1",
  revision: "coverage-r1",
  runId: "run",
  createdBefore: 1000,
  verifiedAt: 2000000,
  enumeration: "complete",
  catchUp: "complete",
  state: "unused",
  writerBoundaryRevision: boundary.revision,
};
const write = () =>
  getHistoricalOfferImportRepository().compareAndWrite({
    next: coverage,
    expected: undefined,
    usageNext: undefined,
    usageExpected: undefined,
    pointer: undefined,
    operation: undefined,
    boundary,
  });
beforeEach(() => {
  resetMockStore();
  getMockStore().subscriptions.delete(guildId);
});
test("caller complete flags without a stored deployment boundary cannot publish unused", async () => {
  expect(await write()).toBe(false);
});
test("a verified stored writer boundary allows an atomic coverage claim", async () => {
  getMockStore().historyWriterBoundaries.set(
    historyWriterBoundaryKey(boundary.accountId, boundary.mode),
    structuredClone(boundary),
  );
  expect(await write()).toBe(true);
});
test("a deployment boundary revision change fences a stale completion claim", async () => {
  getMockStore().historyWriterBoundaries.set(
    historyWriterBoundaryKey(boundary.accountId, boundary.mode),
    { ...boundary, revision: "newer" },
  );
  expect(await write()).toBe(false);
});
