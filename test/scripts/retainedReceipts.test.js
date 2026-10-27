import { test, expect } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  receiptBoundary,
  receiptWriterClosureContract,
  preservedUnadmittedReceipt,
} from "../../scripts/deployment/retained-receipts.cjs";
import {
  classifyRetainedWork,
  readRetainedMetadata,
} from "../../scripts/deployment/retained-work.cjs";
const writer = {
  kind: "ecs",
  instanceId: "synthetic",
  protocolVersion: 1,
  taskArn: "fixture-task",
  imageDigest: "fixture-image",
  candidateId: "fixture-candidate",
};
const hold = {
  holdId: "fixture-hold",
  introductionId: "fixture-introduction",
  revision: 1,
};
const row = {
  eventId: "fixture",
  state: "processing",
  birth: { version: receiptBoundary, writer, hold },
  continuation: "not_admitted",
};
const binding = {
  predicate: receiptBoundary,
  projection: "stripe-receipt-metadata-v1",
  consumerSourceCommit: "a".repeat(40),
  ownershipEvidenceHash: "b".repeat(64),
  reviewedDispositionHash: "c".repeat(64),
  hold,
  writers: [{ identity: writer, sourceCommit: "a".repeat(40) }],
};
test("the versioned predicate describes preserved future work without authorizing it", () => {
  expect(receiptWriterClosureContract.parse(binding)).toEqual(binding);
  expect(preservedUnadmittedReceipt(row, binding)).toBe(
    "preserved_unadmitted_receipt",
  );
  const result = classifyRetainedWork(
    {
      records: [
        {
          table: "stripeWebhook",
          key: { eventId: row.eventId },
          metadata: row,
        },
      ],
      coverage: [],
      observedAt: 1,
    },
    undefined,
    binding,
  );
  expect(result.reopeningBlockers).toContain("uncertain_external_effect");
});
test.each([
  { birth: undefined },
  { birth: { ...row.birth, version: "old" } },
  { birth: { ...row.birth, writer: { ...writer, taskArn: "unknown" } } },
  { birth: { ...row.birth, hold: { ...hold, revision: 2 } } },
  { firstAdmission: {} },
  { admission: { status: "failed" } },
  { continuation: "admitted" },
  { expiresAt: 1 },
])("rejects legacy, unknown lineage or admission history: %j", (patch) => {
  expect(preservedUnadmittedReceipt({ ...row, ...patch }, binding)).not.toBe(
    "preserved_unadmitted_receipt",
  );
});
test("caller hashes alone and mismatched source do not qualify a receipt", () => {
  expect(preservedUnadmittedReceipt(row, { ...binding, writers: [] })).toBe(
    "unknown_metadata",
  );
  expect(
    preservedUnadmittedReceipt(row, {
      ...binding,
      consumerSourceCommit: "d".repeat(40),
    }),
  ).toBe("unknown_metadata");
});
test("safe projection preserves even empty admission presence and excludes payload content", async () => {
  const snapshot = await readRetainedMetadata({
    tables: { stripeWebhook: "receipt" },
    now: 1,
    read: async (_operation, input) =>
      input.TableName === "receipt"
        ? {
            Items: [
              marshall({
                ...row,
                firstAdmission: {},
                payload: { private: "forbidden" },
              }),
            ],
          }
        : { Items: [] },
  });
  const projected = snapshot.records.find(
    (r) => r.table === "stripeWebhook",
  ).metadata;
  expect(projected.firstAdmission).toBe(true);
  expect(projected.payload).toBeUndefined();
  expect(preservedUnadmittedReceipt(projected, binding)).toBe(
    "uncertain_external_effect",
  );
});
