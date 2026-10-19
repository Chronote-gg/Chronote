/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  readRetainedMetadata,
  classifyRetainedWork,
  projections,
} from "../../scripts/deployment/retained-work.cjs";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { fixture } from "../fixtures/productionManifest.js";
async function snapshot(records = {}, override) {
  const tables = fixture().resources.tables;
  return readRetainedMetadata({
    tables,
    now: 150,
    read:
      override ??
      (async (_operation, input) => ({
        Items: (
          records[
            Object.keys(tables).find((k) => tables[k] === input.TableName)
          ] ?? []
        ).map(marshall),
      })),
  });
}
test("uses only safe leaf projections and exhausts pages with consistent reads", async () => {
  const calls = [];
  const s = await snapshot({}, async (operation, input) => {
    calls.push({ operation, input });
    return { Items: [] };
  });
  expect(calls).toHaveLength(8);
  expect(
    calls.every(
      (c) => c.operation === "scan" && c.input.ConsistentRead === true,
    ),
  ).toBe(true);
  for (const fields of Object.values(projections))
    for (const field of fields)
      expect([
        "notes",
        "transcript",
        "context",
        "checkpoint",
        "capture",
        "delivery",
        "recovery",
        "sourceManifest",
        "input",
        "result",
        "errorMessage",
        "lastError",
        "encryptedAccessToken",
        "originalFileName",
      ]).not.toContain(field);
  expect(classifyRetainedWork(s).reopeningBlockers).toEqual([]);
});
test("terminal safe data passes while queued, expired processing, unknown effects and late uploads block", async () => {
  const s = await snapshot({
    personalJob: [
      {
        uploadId: "safe",
        status: "complete",
        completedAt: "2026-10-18T00:00:00Z",
      },
      { uploadId: "late", status: "pending_upload", expiresAt: 1 },
      { uploadId: "claimed", status: "processing", claimExpiresAt: 1 },
      { uploadId: "queued", status: "queued" },
    ],
    stripeWebhook: [
      { eventId: "done", state: "completed", receivedAt: "now", expiresAt: 1 },
      { eventId: "active", state: "processing", leaseUntil: 1 },
      { eventId: "legacy", receivedAt: "now", expiresAt: 1 },
    ],
    notion: [
      {
        pk: "GUILD#g",
        sk: "RESERVE#m",
        recordType: "automation_export_reservation",
      },
    ],
    guildSubscription: [
      {
        guildId: "CHANGE_OP#g#safe",
        state: "canceled",
        operationId: "safe",
        revision: "r",
        reconciled: true,
      },
      {
        guildId: "CHANGE_OP#g#unsafe",
        state: "succeeded",
        operationId: "unsafe",
        revision: "r",
      },
      {
        guildId: "RENEWAL_RECOVERY#g#s#1",
        state: "watching",
        revision: "r",
        nextCheckAt: 1,
      },
    ],
  });
  const result = classifyRetainedWork(s);
  expect(result.preservesData).toBe(true);
  expect(
    result.records.filter((r) => r.category === "safe_terminal"),
  ).toHaveLength(3);
  expect(result.records.find((r) => r.key.uploadId === "late").category).toBe(
    "late_upload_exposure",
  );
  expect(result.records.find((r) => r.key.eventId === "active").category).toBe(
    "uncertain_external_effect",
  );
  expect(result.reopeningBlockers).toHaveLength(8);
});
test("missing checkpoint stays blocked unless exact metadata and positive no-adoption predicate are reviewed", async () => {
  const record = {
    guildId: "g",
    channelId_timestamp: "c#t",
    meetingId: "m",
    status: "interrupted",
  };
  const s = await snapshot({ meetingHistory: [record] });
  expect(classifyRetainedWork(s).records[0].category).toBe(
    "interrupted_legacy",
  );
  const disposition = {
    schemaVersion: 1,
    predicate: "missing-owner-or-version-v1",
    sourceCommit: "a".repeat(40),
    records: [
      {
        keyHash: canonicalHash({ guildId: "g", channelId_timestamp: "c#t" }),
        metadataHash: canonicalHash(record),
        disposition: "preserve_nonadoptable_legacy",
      },
    ],
  };
  expect(classifyRetainedWork(s, disposition).reopeningBlockers).toEqual([]);
  expect(
    classifyRetainedWork(s, {
      ...disposition,
      records: [{ ...disposition.records[0], metadataHash: "b".repeat(64) }],
    }).reopeningBlockers,
  ).toHaveLength(1);
  const linked = await snapshot({
    meetingHistory: [record],
    meetingControl: [
      {
        requestId: "r",
        queueStatus: "pending",
        input: { serverId: "g", meetingId: "m" },
      },
    ],
  });
  expect(
    classifyRetainedWork(linked, disposition).reopeningBlockers.length,
  ).toBeGreaterThan(0);
});
test("incomplete scans and repeated continuation keys never become empty successful snapshots", async () => {
  const s = await snapshot({}, async () => ({
    Items: [],
    LastEvaluatedKey: marshall({ id: "loop" }),
  }));
  expect(classifyRetainedWork(s).reopeningBlockers).toContain(
    "metadata_incomplete",
  );
  const missing = await snapshot({}, async () => ({}));
  expect(classifyRetainedWork(missing).reopeningBlockers).toContain(
    "metadata_incomplete",
  );
});
