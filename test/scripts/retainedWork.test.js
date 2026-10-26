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
import { changeOperation } from "../fixtures/billingChange";
import { billingChangeOperationSchema } from "../../src/types/billingChange";
import { renewalRecoverySchema } from "../../src/types/renewalRecovery";
import {
  pending,
  running,
  parts,
} from "../types/meetingUpdateDelivery.fixture";
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

test.each([
  { updateDelivery: pending() },
  { updateDelivery: running() },
  { updateDelivery: running("verified") },
  {
    updateDelivery: {
      ...pending(),
      policy: { kind: "held", reason: "explicit_hold" },
    },
  },
  {
    updateDelivery: {
      ...pending(),
      progress: { kind: "synced", syncedAt: 150 },
      parts: parts(),
    },
  },
  { publicationRepair: { kind: "running", runId: "repair" } },
  { publicationRepair: { kind: "settled", runId: "repair" } },
  { contentRevision: 1 },
  { contentMutation: { id: "mutation", fingerprint: "a".repeat(64) } },
  { updateDeliveryQueue: "meeting-update:v1" },
  { updateDeliveryDueAt: 1 },
])(
  "new publication metadata never becomes A acknowledgment: %j",
  async (addition) => {
    for (const terminal of [false, true]) {
      const row = {
        guildId: "g",
        channelId_timestamp: "c#t",
        meetingId: "m",
        status: "complete",
        ...(terminal
          ? {
              checkpoint: { schemaVersion: 1 },
              recovery: { disposition: "done" },
            }
          : {}),
        ...addition,
      };
      const s = await snapshot({ meetingHistory: [row] });
      const review = {
        schemaVersion: 1,
        predicate: "missing-owner-or-version-v1",
        sourceCommit: "a".repeat(40),
        records: [
          {
            keyHash: canonicalHash(s.records[0].key),
            metadataHash: canonicalHash(s.records[0].metadata),
            disposition: "preserve_nonadoptable_legacy",
          },
        ],
      };
      expect(classifyRetainedWork(s, review).reopeningBlockers).not.toEqual([]);
    }
  },
);

test.each([undefined, 0])(
  "untouched completed history keeps initial content revision %s",
  async (contentRevision) => {
    const s = await snapshot({
      meetingHistory: [
        {
          guildId: "g",
          channelId_timestamp: "c#t",
          meetingId: "m",
          status: "complete",
          checkpoint: { schemaVersion: 1 },
          recovery: { disposition: "done" },
          ...(contentRevision === undefined ? {} : { contentRevision }),
        },
      ],
    });
    expect(classifyRetainedWork(s).reopeningBlockers).toEqual([]);
  },
);
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
        guildId: "CHANGE_OP#12345678901234567#safe",
        state: "canceled",
        operationId: "safe",
        revision: "r",
        reconciled: true,
      },
      {
        guildId: "CHANGE_OP#12345678901234567#unsafe",
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

test("completed personal claim receipt is historical only when active ownership is cleared", async () => {
  // personalMediaUploadProcessingService.finish: spread job, retain claim, clear owner/expiry.
  const job = {
    uploadId: "done",
    status: "complete",
    completedAt: "2026-10-18T00:00:00Z",
    processingClaimId: "claim-receipt",
    meetingGuildId: "personal:user",
    meetingId: "meeting",
    channelId_timestamp: "channel#time",
  };
  const result = classifyRetainedWork(await snapshot({ personalJob: [job] }));
  expect(result.reopeningBlockers).toEqual([]);
  for (const invalid of [
    { processingOwnerInstanceId: "old-owner" },
    { claimExpiresAt: 1 },
    { status: "processing" },
    { completedAt: "" },
  ]) {
    expect(
      classifyRetainedWork(
        await snapshot({ personalJob: [{ ...job, ...invalid }] }),
      ).reopeningBlockers,
    ).not.toEqual([]);
  }
});

const guild = "12345678901234567";
const opId = "12345678-1234-4234-8234-123456789012";
function billingRows(state = "watching") {
  // renewalRecoveryService.trackPaidRenewalPeriod + db.writeRenewalRecoveryRecord.
  const logicalRecovery = renewalRecoverySchema.parse({
    guildId: guild,
    subscriptionId: "sub_test",
    customerId: "cus_test",
    payerId: "payer",
    mode: "test",
    revision: "revision",
    paid: {
      invoiceId: "in_paid",
      priceId: "price_old",
      tier: "basic",
      interval: "month",
      periodStart: 100,
      periodEnd: 300,
    },
    scheduledOperationId: null,
    enforcementAccepted: false,
    writerVersion: "renewal-grace-v1",
    writerRuntime: {
      taskArn: "arn:aws:ecs:us-east-1:123456789012:task/app/old",
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
    state,
    ...(state === "watching" ? { nextCheckAt: 300 } : {}),
  });
  const recovery = {
    ...logicalRecovery,
    ownerGuildId: guild,
    guildId: `RENEWAL_RECOVERY#${guild}#sub_test#300`,
    ...(state === "watching"
      ? { recoveryQueue: "test", recoveryDueAt: 300 }
      : {}),
  };
  return [
    {
      guildId: guild,
      stripeSubscriptionId: "sub_test",
      stripeCustomerId: "cus_test",
      stripeSyncRevision: "sync",
    },
    recovery,
    {
      guildId: `RENEWAL_RECOVERY_CURRENT#${guild}`,
      key: recovery.guildId,
      revision: recovery.revision,
      blocking: false,
    },
  ];
}
function scheduledRows() {
  // afterAcceptance persists a schema-checked schedule receipt, then db.ts tags the physical key.
  const operation = billingChangeOperationSchema.parse({
    ...changeOperation,
    guildId: guild,
    operationId: opId,
    revision: "change-revision",
    payerId: "payer",
    state: "scheduled",
    timing: "renewal",
    scheduleId: "sub_sched_known",
    consent: { at: 120, quoteRevision: "accepted-revision" },
    source: {
      ...changeOperation.source,
      subscriptionId: "sub_test",
      periodStart: 100,
      periodEnd: 300,
      revision: "sync",
    },
  });
  return [
    ...billingRows(),
    { guildId: `CHANGE_CONTROL#${guild}`, operationId: opId },
    { ...operation, guildId: `CHANGE_OP#${guild}#${opId}` },
  ];
}
function reviewedFuture(s) {
  const consumerSourceCommit = "b".repeat(40),
    ownershipEvidenceHash = "c".repeat(64);
  const relatedMetadataHash = canonicalHash(
    s.records
      .filter((r) => r.table === "guildSubscription")
      .map((r) => ({ key: r.key, metadata: r.metadata }))
      .sort((a, b) => a.key.guildId.localeCompare(b.key.guildId)),
  );
  const compatibleFuture = {
    predicate: "billing-future-v1",
    projection: "billing-metadata-v1",
    consumerSourceCommit,
    ownershipEvidenceHash,
    records: s.records
      .filter((r) => ["watching", "scheduled"].includes(r.metadata.state))
      .map((r) => ({
        keyHash: canonicalHash(r.key),
        metadataHash: canonicalHash(r.metadata),
        relatedMetadataHash,
        ...(r.metadata.state === "scheduled"
          ? {
              scheduleAcknowledgment: {
                scheduleId: r.metadata.scheduleId,
                operationId: r.metadata.operationId,
                receiptHash: "d".repeat(64),
              },
            }
          : {}),
      })),
  };
  const review = {
    schemaVersion: 1,
    predicate: "missing-owner-or-version-v1",
    sourceCommit: consumerSourceCommit,
    records: [],
    compatibleFuture,
  };
  return [
    review,
    {
      consumerSourceCommit,
      ownershipEvidenceHash,
      reviewedDispositionHash: canonicalHash(review),
    },
  ];
}

test("terminal recovery has an exact nonblocking current pointer; missing, mismatched and active targets block", async () => {
  const records = billingRows("ended");
  expect(
    classifyRetainedWork(await snapshot({ guildSubscription: records }))
      .reopeningBlockers,
  ).toEqual([]);
  for (const mutate of [
    (rows) => rows.splice(1, 1),
    (rows) => (rows[2].revision = "stale"),
    (rows) => (rows[2].key += "wrong"),
    (rows) => (rows[2].blocking = true),
    (rows) => (rows[1].ownerGuildId = "98765432109876543"),
    (rows) => (rows[1].state = "canceling"),
  ]) {
    const rows = structuredClone(records);
    mutate(rows);
    expect(
      classifyRetainedWork(await snapshot({ guildSubscription: rows }))
        .reopeningBlockers,
    ).not.toEqual([]);
  }
});

test("reviewed legacy preservation ignores safe same-guild records but refuses unresolved actual or ambiguous links", async () => {
  const history = {
    guildId: guild,
    channelId_timestamp: "c#t",
    meetingId: "m",
    status: "interrupted",
  };
  const review = {
    schemaVersion: 1,
    predicate: "missing-owner-or-version-v1",
    sourceCommit: "a".repeat(40),
    records: [
      {
        keyHash: canonicalHash({ guildId: guild, channelId_timestamp: "c#t" }),
        metadataHash: canonicalHash(history),
        disposition: "preserve_nonadoptable_legacy",
      },
    ],
  };
  const records = {
    meetingHistory: [history],
    guildSubscription: [{ guildId: guild }],
    meetingControl: [
      {
        requestId: "done",
        queueStatus: "completed",
        input: { serverId: guild, meetingId: "m" },
      },
    ],
    notion: [
      {
        pk: "export",
        sk: "meeting",
        recordType: "meeting_export",
        guildId: guild,
        channelId_timestamp: "c#t",
        notionPageId: "page",
        lastExportedAt: "now",
      },
    ],
  };
  expect(
    classifyRetainedWork(await snapshot(records), review).reopeningBlockers,
  ).toEqual([]);
  for (const meetingId of ["m", undefined]) {
    const linked = structuredClone(records);
    linked.meetingControl = [
      {
        requestId: "active",
        queueStatus: "pending",
        input: { serverId: guild, ...(meetingId ? { meetingId } : {}) },
      },
    ];
    expect(
      classifyRetainedWork(await snapshot(linked), review).records.find(
        (r) => r.table === "meetingHistory",
      ).category,
    ).toBe("interrupted_legacy");
  }
  records.meetingControl = [
    {
      requestId: "other",
      queueStatus: "pending",
      input: { serverId: guild, meetingId: "different" },
    },
  ];
  expect(
    classifyRetainedWork(await snapshot(records), review).records.find(
      (r) => r.table === "meetingHistory",
    ).category,
  ).toBe("preserved_nonadoptable_legacy");
});

test.each([billingRows, scheduledRows])(
  "future work needs exact reviewed source, ownership and row evidence",
  async (makeRows) => {
    const s = await snapshot({ guildSubscription: makeRows() });
    expect(classifyRetainedWork(s).reopeningBlockers).not.toEqual([]);
    const [review, binding] = reviewedFuture(s);
    expect(classifyRetainedWork(s, review, binding).reopeningBlockers).toEqual(
      [],
    );
    expect(
      classifyRetainedWork(s, review, binding).records.some(
        (r) => r.category === "preserved_compatible_future",
      ),
    ).toBe(true);
    for (const invalid of [
      undefined,
      { ...binding, consumerSourceCommit: "e".repeat(40) },
      { ...binding, ownershipEvidenceHash: "f".repeat(64) },
      { ...binding, reviewedDispositionHash: "0".repeat(64) },
    ]) {
      expect(
        classifyRetainedWork(s, review, invalid).reopeningBlockers,
      ).not.toEqual([]);
    }
  },
);

test("future predicates reject active, malformed, due, missing and uncertain billing even with freshly bound review", async () => {
  for (const mutate of [
    (rows) => (rows[1].receipts = { canceled: true }),
    (rows) => (rows[1].projection = { state: "pending", nextCheckAt: 100 }),
    (rows) => (rows[4].providerScheduleId = "still-accepted"),
    (rows) => (rows[4].reconciled = true),
    (rows) => (rows[2].operationId = opId),
    (rows) => (rows[3].state = "processing"),
    (rows) => (rows[1].enforcementAccepted = true),
    (rows) => (rows[1].recoveryDueAt = 100),
    (rows) => (rows[1].nextCheckAt = 100),
    (rows) => (rows[1].writerVersion = "unknown"),
    (rows) => (rows[1].scheduledOperationId = opId),
    (rows) => (rows[2].revision = "stale"),
    (rows) => (rows[0].stripeSubscriptionId = "foreign"),
    (rows) => rows.splice(2, 1),
    (rows) => (rows[4].state = "accepted"),
    (rows) => (rows[4].scheduleId = null),
    (rows) => (rows[4].consent = null),
    (rows) => (rows[4].source.periodEnd = 100),
    (rows) => (rows[3].operationId = "other"),
  ]) {
    const rows = scheduledRows();
    mutate(rows);
    const s = await snapshot({ guildSubscription: rows });
    expect(
      classifyRetainedWork(s, ...reviewedFuture(s)).reopeningBlockers,
    ).not.toEqual([]);
  }
  const s = await snapshot({ guildSubscription: scheduledRows() });
  const [review, binding] = reviewedFuture(s);
  review.compatibleFuture.records.find(
    (r) => r.scheduleAcknowledgment,
  ).scheduleAcknowledgment.scheduleId = "foreign";
  binding.reviewedDispositionHash = canonicalHash(review);
  expect(
    classifyRetainedWork(s, review, binding).reopeningBlockers,
  ).not.toEqual([]);
});

test("renewal controls remain unsettled claims even when their original revision differs or target is terminal", async () => {
  const target = {
    guildId: `RENEWAL_OP#${guild}#${opId}`,
    operationId: opId,
    revision: "advanced",
    state: "verifying",
  };
  const control = {
    guildId: `RENEWAL_CONTROL#${guild}`,
    operationId: opId,
    revision: "claim-original",
  };
  for (const state of ["verifying", "succeeded", "rejected"]) {
    const s = await snapshot({
      guildSubscription: [{ ...target, state }, control],
    });
    expect(
      classifyRetainedWork(s).records.find(
        (r) => r.key.guildId === control.guildId,
      ).category,
    ).toBe("unsettled_claim_control");
  }
  expect(
    classifyRetainedWork(
      await snapshot({
        guildSubscription: [{ ...target, state: "succeeded" }],
      }),
    ).reopeningBlockers,
  ).toEqual([]);
  expect(
    classifyRetainedWork(await snapshot({ guildSubscription: [control] }))
      .reopeningBlockers,
  ).toContain("unknown_metadata");
});
