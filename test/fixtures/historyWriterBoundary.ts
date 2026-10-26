import { getMockStore } from "../../src/repositories/mockStore";
import { historyWriterBoundaryKey } from "../../src/types/historyWriterBoundary";
import { historicalOfferImportKey } from "../../src/types/historicalOfferImport";
import type { HistoryWriterBoundary } from "../../src/types/historyWriterBoundary";
export const testWriterImageDigest = "sha256:" + "a".repeat(64);
export function historyWriterBoundaryFixture(): HistoryWriterBoundary {
  return {
    accountId: "acct-owned",
    mode: "test",
    revision: "boundary-r1",
    writerVersion: "offer-ledger-v1",
    state: "verified",
    cutoverAt: 500000,
    verifiedAt: 600000,
    deploymentReceiptId: "owned-test-acceptance",
    deployment: {
      clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/test",
      serviceArn: "arn:aws:ecs:us-east-1:123456789012:service/test/api",
      containerName: "api",
      imageDigest: testWriterImageDigest,
      taskDefinitionArn:
        "arn:aws:ecs:us-east-1:123456789012:task-definition/api:2",
      taskArns: ["arn:aws:ecs:us-east-1:123456789012:task/test/task-one"],
    },
    sample: {
      guildId: "111111111111111111",
      attemptId: "current",
      revision: "current-r1",
    },
  };
}

export function seedUnusedOfferCoverage(guildId = "111111111111111111") {
  const store = getMockStore();
  const boundary = historyWriterBoundaryFixture();
  store.historyWriterBoundaries.set(
    historyWriterBoundaryKey(boundary.accountId, boundary.mode),
    boundary,
  );
  for (const offerId of ["basic_intro_v1", "basic_annual_intro_v1"] as const) {
    store.historicalOfferImports.set(
      historicalOfferImportKey(
        guildId,
        offerId,
        boundary.mode,
        boundary.accountId,
      ),
      {
        guildId,
        accountId: boundary.accountId,
        mode: boundary.mode,
        offerId,
        revision: "coverage-" + offerId,
        runId: "run",
        createdBefore: 1000,
        verifiedAt: 2000000,
        enumeration: "complete",
        catchUp: "complete",
        state: "unused",
        writerBoundaryRevision: boundary.revision,
      },
    );
  }
}
