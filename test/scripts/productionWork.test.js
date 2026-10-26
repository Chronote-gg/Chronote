/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  classifyProductionWork,
  assertProductionDrain,
  scanProductionWork,
} from "../../scripts/deployment/production-work.cjs";
import { createHash } from "node:crypto";
const digest = (row) =>
  createHash("sha256").update(JSON.stringify(row)).digest("hex");
const tables = [
  "leases",
  "history",
  "controls",
  "uploads",
  "segments",
  "billing",
  "webhooks",
  "payments",
];
const tableArns = Object.fromEntries(
  tables.map((name) => [
    name,
    `arn:aws:dynamodb:us-east-1:123456789012:table/${{ leases: "ActiveMeetingTable", uploads: "PersonalMediaUploadJobTable" }[name] ?? name}`,
  ]),
);
const binding = {
  accountId: "123456789012",
  region: "us-east-1",
  taskRoleArn: "arn:aws:iam::123456789012:role/synthetic",
  activeMeetingTableArn: tableArns.leases,
  personalMediaUploadJobTableArn: tableArns.uploads,
  operationId: "11111111-1111-4111-8111-111111111111",
  sourceSha: "a".repeat(40),
  legacySha: "b".repeat(40),
  candidateDigest: "sha256:" + "c".repeat(64),
  tableArns,
};
const compatibility = { binding, uploads: [] };
function snapshot(rows = {}) {
  const data = Object.fromEntries(
    tables.map((name) => [name, rows[name] ?? []]),
  );
  return {
    binding,
    observedAt: 100,
    owners: ["old"],
    tables: data,
    settlements: [],
    scans: Object.fromEntries(
      tables.map((name) => [
        name,
        {
          tableArn: binding.tableArns[name],
          complete: true,
          pages: [
            {
              startKey: null,
              endKey: null,
              count: data[name].length,
              digest: digest(data[name]),
            },
          ],
        },
      ]),
    ),
  };
}
function upload(status = "queued") {
  return {
    uploadId: "upload",
    ownerUserId: "user",
    status,
    sourceS3Key: "synthetic",
    contentType: "audio/wav",
    fileSize: 10,
    mediaKind: "audio",
  };
}
function compatible(row) {
  return {
    binding,
    uploads: [
      {
        uploadId: row.uploadId,
        rowDigest: digest(row),
        sourceInput: "verified",
        token: "verified",
        schema: "verified",
        ownership: "verified",
        claimProtocol: "verified",
        evidenceId: "local-fixture",
        validUntil: 200,
      },
    ],
  };
}
function settled(snap, table, row) {
  snap.settlements.push({
    table,
    rowDigest: digest(row),
    effects: "acknowledged",
    evidenceId: "fixture-reconciliation",
  });
  return snap;
}
function proof(snap = snapshot(), compat = compatibility) {
  return {
    snapshot: snap,
    compatibility: compat,
    barrier: {
      binding,
      evidenceId: "fixture-fence",
      admission: "closed",
      effects: "settled",
      owners: ["old"],
      fencedAt: 99,
      checkedAt: 101,
      validUntil: 200,
      revisionBefore: "claim-generation-1",
      revisionAfter: "claim-generation-1",
    },
    now: 102,
  };
}
test("retains terminal history without changing row bytes", () => {
  const row = {
    guildId: "g",
    channelId_timestamp: "c#1",
    meetingId: "m",
    status: "complete",
  };
  const snap = settled(snapshot({ history: [row] }), "history", row);
  const before = JSON.stringify(snap);
  expect(classifyProductionWork(snap, compatibility).counts).toMatchObject({
    retained: 1,
    blocked: 0,
  });
  expect(JSON.stringify(snap)).toBe(before);
  expect(() => assertProductionDrain(proof(snap), binding)).not.toThrow();
});
test.each([
  [
    "active lease",
    "leases",
    {
      guildId: "g",
      meetingId: "m",
      ownerInstanceId: "old",
      leaseExpiresAt: 150,
    },
    "active",
  ],
  [
    "expired lease",
    "leases",
    {
      guildId: "g",
      meetingId: "m",
      ownerInstanceId: "old",
      leaseExpiresAt: 90,
    },
    "blocked",
  ],
  [
    "foreign owner",
    "leases",
    {
      guildId: "g",
      meetingId: "m",
      ownerInstanceId: "foreign",
      leaseExpiresAt: 150,
    },
    "blocked",
  ],
  [
    "nonterminal history",
    "history",
    {
      guildId: "g",
      channelId_timestamp: "c#1",
      meetingId: "m",
      status: "processing",
    },
    "blocked",
  ],
  [
    "delivery uncertainty",
    "history",
    {
      guildId: "g",
      channelId_timestamp: "c#1",
      meetingId: "m",
      status: "complete",
    },
    "blocked",
  ],
  [
    "processing claim",
    "uploads",
    {
      ...upload("processing"),
      processingOwnerInstanceId: "old",
      claimExpiresAt: 150,
    },
    "active",
  ],
  [
    "expired processing claim",
    "uploads",
    {
      ...upload("processing"),
      processingOwnerInstanceId: "old",
      claimExpiresAt: 90,
    },
    "blocked",
  ],
  [
    "pending upload without expiry",
    "uploads",
    upload("pending_upload"),
    "blocked",
  ],
  [
    "queued start",
    "controls",
    {
      requestId: "r",
      commandType: "start_meeting",
      queueStatus: "pending",
      expiresAt: 90,
    },
    "active",
  ],
  [
    "pending billing operation",
    "billing",
    { guildId: "CHANGE_OP#g#o", state: "applying", expiresAt: 90 },
    "blocked",
  ],
  [
    "unreconciled billing terminal",
    "billing",
    { guildId: "CHANGE_OP#g#o", state: "succeeded" },
    "blocked",
  ],
])("blocks drain for %s", (_name, table, row, category) => {
  const snap = snapshot({ [table]: [row] });
  expect(classifyProductionWork(snap, compatibility)[category]).toHaveLength(1);
  expect(() => assertProductionDrain(proof(snap), binding)).toThrow();
});
test.each(["queued", "pending_upload"])(
  "carries compatible unclaimed %s input without rewriting it",
  (status) => {
    const row = upload(status);
    const snap = snapshot({ uploads: [row] });
    const compat = compatible(row);
    const before = JSON.stringify(snap);
    expect(classifyProductionWork(snap, compat).portable).toHaveLength(1);
    expect(() =>
      assertProductionDrain(proof(snap, compat), binding),
    ).not.toThrow();
    expect(JSON.stringify(snap)).toBe(before);
  },
);
test.each([
  "sourceInput",
  "token",
  "schema",
  "ownership",
  "claimProtocol",
  "rowDigest",
])("rejects missing exact %s compatibility", (field) => {
  const row = upload();
  const compat = compatible(row);
  delete compat.uploads[0][field];
  expect(
    classifyProductionWork(snapshot({ uploads: [row] }), compat).blocked,
  ).toHaveLength(1);
});
test("a retained owner on queued input is not an unclaimed portable job", () => {
  const row = {
    ...upload(),
    processingOwnerInstanceId: "old",
    claimExpiresAt: 90,
  };
  expect(
    classifyProductionWork(snapshot({ uploads: [row] }), compatible(row))
      .blocked,
  ).toHaveLength(1);
});
test.each([
  "missing scan",
  "missing page",
  "changed row",
  "concurrent claim",
  "foreign binding",
  "expired barrier",
  "unknown effects",
])("rejects %s proof", (kind) => {
  const p = proof();
  if (kind === "missing scan") delete p.snapshot.scans.history;
  if (kind === "missing page")
    p.snapshot.scans.history.pages[0].endKey = { guildId: { S: "next" } };
  if (kind === "changed row") p.snapshot.tables.uploads.push(upload());
  if (kind === "concurrent claim")
    p.barrier.revisionAfter = "claim-generation-2";
  if (kind === "foreign binding")
    p.barrier.binding = { ...binding, sourceSha: "d".repeat(40) };
  if (kind === "expired barrier") p.now = 201;
  if (kind === "unknown effects") p.barrier.effects = "unknown";
  expect(() => assertProductionDrain(p, binding)).toThrow();
});
test("scan follows every page with metadata projections and records empty intermediate pages", async () => {
  const calls = [];
  const key = { uploadId: { S: "cursor" } };
  const row = upload();
  const aws = async (service, operation, input) => {
    calls.push({ service, operation, input });
    if (
      input.TableName === binding.tableArns.uploads &&
      !input.ExclusiveStartKey
    )
      return { Items: [], LastEvaluatedKey: key };
    return {
      Items:
        input.TableName === binding.tableArns.uploads ? [marshall(row)] : [],
    };
  };
  const result = await scanProductionWork(aws, {
    binding,
    observedAt: 100,
    owners: ["old"],
  });
  expect(result.tables.uploads).toEqual([row]);
  expect(result.scans.uploads.pages).toHaveLength(2);
  expect(result.scans.uploads.pages[1].startKey).toEqual(key);
  for (const { service, operation, input } of calls) {
    expect([service, operation]).toEqual(["dynamodb", "scan"]);
    expect(input.ConsistentRead).toBe(true);
    expect(input.ProjectionExpression).toBeTruthy();
    expect(Object.values(input.ExpressionAttributeNames)).not.toEqual(
      expect.arrayContaining([
        "notes",
        "transcript",
        "title",
        "input",
        "result",
        "sourceManifest",
      ]),
    );
  }
});
test("scan refuses repeated cursors and bounded incomplete inventories", async () => {
  const aws = async () => ({
    Items: [],
    LastEvaluatedKey: { guildId: { S: "same" } },
  });
  await expect(
    scanProductionWork(aws, {
      binding,
      observedAt: 100,
      owners: ["old"],
      maxPages: 2,
    }),
  ).rejects.toThrow();
});

const guild = "123456789012345678";
const operation = "22222222-2222-4222-8222-222222222222";
const billingCases = [
  [
    "subscription projection",
    {
      guildId: guild,
      status: "active",
      tier: "basic",
      subscriptionType: "monthly",
      startDate: "2026-01-01T00:00:00Z",
    },
    "retained",
  ],
  ["malformed subscription", { guildId: guild, status: "active" }, "blocked"],
  [
    "terminal change",
    {
      guildId: `CHANGE_OP#${guild}#${operation}`,
      operationId: operation,
      revision: "r",
      state: "succeeded",
      reconciled: true,
    },
    "retained",
  ],
  [
    "unreconciled change",
    {
      guildId: `CHANGE_OP#${guild}#${operation}`,
      operationId: operation,
      revision: "r",
      state: "succeeded",
    },
    "blocked",
  ],
  [
    "completed renewal",
    {
      guildId: `RENEWAL_OP#${guild}#${operation}`,
      operationId: operation,
      revision: "r",
      state: "succeeded",
    },
    "retained",
  ],
  [
    "uncertain renewal",
    {
      guildId: `RENEWAL_OP#${guild}#${operation}`,
      operationId: operation,
      revision: "r",
      state: "needs_review",
    },
    "blocked",
  ],
  [
    "completed purchase",
    {
      guildId: `PURCHASE#${guild}`,
      attemptId: operation,
      revision: "r",
      state: "completed",
    },
    "retained",
  ],
  [
    "open purchase",
    {
      guildId: `PURCHASE#${guild}`,
      attemptId: operation,
      revision: "r",
      state: "open",
    },
    "blocked",
  ],
  [
    "completed purchase with incident",
    {
      guildId: `PURCHASE#${guild}`,
      attemptId: operation,
      revision: "r",
      state: "completed",
      incidentKey: "incident",
    },
    "blocked",
  ],
  [
    "unknown namespace",
    {
      guildId: `UNRECOGNIZED#${guild}`,
      revision: "r",
      state: "succeeded",
      reconciled: true,
    },
    "blocked",
  ],
  [
    "paid recovery with pending projection",
    {
      guildId: `RENEWAL_RECOVERY#${guild}#sub_fixture#100`,
      revision: "r",
      state: "paid",
      projection: { state: "pending" },
    },
    "blocked",
  ],
  [
    "paid recovery with completed projection",
    {
      guildId: `RENEWAL_RECOVERY#${guild}#sub_fixture#100`,
      revision: "r",
      state: "paid",
      projection: { state: "complete" },
    },
    "retained",
  ],
  [
    "canceled recovery without native receipts",
    {
      guildId: `RENEWAL_RECOVERY#${guild}#sub_fixture#100`,
      revision: "r",
      state: "canceled",
    },
    "blocked",
  ],
  [
    "canceled recovery with native receipts",
    {
      guildId: `RENEWAL_RECOVERY#${guild}#sub_fixture#100`,
      revision: "r",
      state: "canceled",
      receipts: {
        canceled: true,
        collectionRestored: true,
        collectionToRestore: [],
      },
    },
    "retained",
  ],
  [
    "reserved offer",
    {
      guildId: `OFFER#test#${guild}#basic_intro_v1`,
      revision: "r",
      state: "reserved",
    },
    "blocked",
  ],
  [
    "used offer receipt",
    {
      guildId: `OFFER#test#${guild}#basic_intro_v1`,
      revision: "r",
      state: "used",
      settlement: { status: "paid", settledAt: 50 },
    },
    "retained",
  ],
  [
    "unresolved offer history",
    {
      guildId: `OFFER_HISTORY#test#acct_fixture#${guild}#basic_intro_v1`,
      revision: "r",
      state: "unresolved",
    },
    "blocked",
  ],
];
test.each(billingCases)(
  "classifies typed %s without inventing financial completion",
  (_name, row, category) => {
    const snap = settled(snapshot({ billing: [row] }), "billing", row);
    expect(classifyProductionWork(snap, compatibility).counts[category]).toBe(
      1,
    );
  },
);
test("control pointers are retained only with the exact terminal target", () => {
  const row = {
    guildId: `RENEWAL_OP#${guild}#${operation}`,
    operationId: operation,
    revision: "r",
    state: "succeeded",
  };
  const pointer = {
    guildId: `RENEWAL_CONTROL#${guild}`,
    operationId: operation,
    revision: "r",
  };
  const snap = settled(snapshot({ billing: [row, pointer] }), "billing", row);
  expect(classifyProductionWork(snap, compatibility).counts.retained).toBe(2);
  const missing = snapshot({ billing: [pointer] });
  expect(classifyProductionWork(missing, compatibility).counts.blocked).toBe(1);
});

test("unknown segment lifecycle cannot become retained from an acknowledgment alone", () => {
  const parent = upload();
  const segment = {
    uploadId: parent.uploadId,
    segmentKey: "source#0",
    ownerUserId: parent.ownerUserId,
    status: "processing",
  };
  const snap = settled(
    snapshot({ uploads: [parent], segments: [segment] }),
    "segments",
    segment,
  );
  expect(classifyProductionWork(snap, compatible(parent)).counts.blocked).toBe(
    1,
  );
});
test("segments require exact compatible parent ownership and per-segment evidence", () => {
  const parent = upload();
  const segment = {
    uploadId: parent.uploadId,
    segmentKey: "source#0",
    ownerUserId: parent.ownerUserId,
    status: "uploaded",
  };
  const snap = snapshot({ uploads: [parent], segments: [segment] });
  const compat = compatible(parent);
  expect(classifyProductionWork(snap, compat).counts.blocked).toBe(1);
  compat.uploads[0].segmentDigests = [digest(segment)];
  expect(classifyProductionWork(snap, compat).counts.portable).toBe(2);
});
test("compatibility cannot make malformed upload metadata portable", () => {
  const row = { ...upload(), sourceS3Key: "", fileSize: -1 };
  expect(
    classifyProductionWork(snapshot({ uploads: [row] }), compatible(row)).counts
      .blocked,
  ).toBe(1);
});

test.each(["webhooks", "payments"])(
  "missing %s pagination never proves drain",
  (table) => {
    const p = proof();
    delete p.snapshot.scans[table];
    expect(() => assertProductionDrain(p, binding)).toThrow();
  },
);
test.each([
  ["processing", { state: "processing", leaseToken: "claim", leaseUntil: 150 }],
  [
    "expired uncertain",
    { state: "processing", leaseToken: "claim", leaseUntil: 90 },
  ],
  ["missing state", {}],
  ["completed without acknowledgment", { state: "completed" }],
])("a %s webhook blocks an otherwise settled inventory", (_name, fields) => {
  const row = { eventId: "evt_synthetic", ...fields };
  const snap = snapshot({ webhooks: [row] });
  expect(classifyProductionWork(snap, compatibility).counts.blocked).toBe(1);
  expect(() => assertProductionDrain(proof(snap), binding)).toThrow();
});
test("a completed acknowledged webhook remains retained", () => {
  const row = { eventId: "evt_synthetic", state: "completed" };
  const snap = settled(snapshot({ webhooks: [row] }), "webhooks", row);
  expect(classifyProductionWork(snap, compatibility).counts.retained).toBe(1);
});
test.each([
  ["paid", "2026-01-01T00:00:00Z", "retained"],
  ["open", "2026-01-01T00:00:00Z", "blocked"],
  ["uncollectible", "2026-01-01T00:00:00Z", "blocked"],
  ["paid", undefined, "blocked"],
])(
  "classifies invoice receipt %s with date %s",
  (status, paymentDate, category) => {
    const row = {
      TransactionID: "in_synthetic",
      transactionID: "in_synthetic",
      status,
      paymentDate,
    };
    expect(
      classifyProductionWork(snapshot({ payments: [row] }), compatibility)
        .counts[category],
    ).toBe(1);
  },
);
test.each([Infinity, "200", null])(
  "rejects non-finite or untyped barrier expiry %s",
  (validUntil) => {
    const p = proof();
    p.barrier.validUntil = validUntil;
    expect(() => assertProductionDrain(p, binding)).toThrow();
  },
);
