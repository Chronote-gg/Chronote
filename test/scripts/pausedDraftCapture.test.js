import { Buffer } from "node:buffer";
/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import { privateCaptureFixture } from "../fixtures/deployment/privateCapture.js";
import { manifestHash } from "../../scripts/deployment/sandbox-manifest.cjs";
import { parseProductionManifest } from "../../scripts/deployment/production-manifest.cjs";
import {
  preparePausedDrafts,
  collectPausedDrafts,
} from "../../scripts/deployment/paused-draft-capture.cjs";
import {
  classifyProductionWork,
  scanProductionWork,
} from "../../scripts/deployment/production-work.cjs";

async function fixture(configure = () => {}) {
  const f = privateCaptureFixture();
  const identities = ["draft-a", "draft-b"].map((uploadId) => ({
    uploadId,
    ownerUserId: "same-owner",
  }));
  const parents = identities.map((identity) => ({
    ...identity,
    status: "pending_upload",
    uploadOrigin: "desktop_recording",
    mediaKind: "audio",
    sourceS3Key: `personal-media-uploads/${identity.ownerUserId}/${identity.uploadId}/segments/`,
    contentType: "audio/wav",
    fileSize: 0,
    sourceManifest: [
      { sourceId: "mic", kind: "owner_mic", label: "Microphone" },
    ],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }));
  const segments = parents.map((parent) => ({
    uploadId: parent.uploadId,
    ownerUserId: parent.ownerUserId,
    segmentKey: "mic#000000",
    sourceId: "mic",
    sequence: 0,
    kind: "owner_mic",
    label: "Microphone",
    sourceS3Key: parent.sourceS3Key + "mic-000000.wav",
    contentType: "audio/wav",
    fileSize: 4,
    checksumSha256: "a".repeat(64),
    durationMillis: 1000,
    status: "uploaded",
    startedAt: parent.createdAt,
    endedAt: parent.updatedAt,
    createdAt: parent.createdAt,
    updatedAt: parent.updatedAt,
  }));
  const markers = new Map(),
    nativeCalls = [];
  const aws = async (service, operation, input) => {
    nativeCalls.push({ service, operation, input });
    if (operation === "get-item") {
      const row =
        input.TableName === f.m.controlTableArn
          ? markers.get(input.Key.pk.S)
          : parents.find((p) => p.uploadId === input.Key.uploadId.S);
      return row ? { Item: marshall(row) } : {};
    }
    if (operation === "query")
      return {
        Items: segments
          .filter(
            (s) =>
              s.uploadId === input.ExpressionAttributeValues[":uploadId"].S,
          )
          .map((s) => marshall(s)),
      };
    if (operation === "head-object")
      return {
        VersionId: input.VersionId ?? "audio-v1",
        ContentLength: 4,
        ContentType: "audio/wav",
        ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
      };
    if (operation === "scan") {
      const all =
        input.TableName === f.m.binding.tableArns.uploads
          ? parents
          : input.TableName === f.m.binding.tableArns.segments
            ? segments
            : [];
      const fields = Object.values(input.ExpressionAttributeNames);
      return {
        Items: all.map((row) =>
          marshall(
            Object.fromEntries(
              Object.entries(row).filter(([key]) => fields.includes(key)),
            ),
          ),
        ),
      };
    }
    throw new Error("unsupported synthetic operation");
  };
  const options = {
    manifest: f.m,
    expectedSha256: manifestHash(f.m),
    identities,
    storageBinding: f.binding,
    s3: f.client,
    aws,
    now: () => 1000,
  };
  await configure({ parents, segments, options, aws, nativeCalls });
  const binding = await preparePausedDrafts(options);
  f.m.pausedDrafts = binding;
  const expectedSha256 = manifestHash(f.m);
  for (const identity of identities)
    markers.set(`UPLOAD#${identity.uploadId}`, {
      pk: `UPLOAD#${identity.uploadId}`,
      sk: "PAUSED_DRAFT",
      recordType: "paused_desktop_draft",
      protocolVersion: 1,
      ...identity,
      operationId: f.m.binding.operationId,
      manifestSha256: expectedSha256,
      preservedCaptureSha256: binding.capture.sha256,
      createdAt: 999,
    });
  const snapshot = await scanProductionWork(aws, {
    binding: f.m.binding,
    observedAt: 1000,
    owners: [],
  });
  return {
    ...f,
    parents,
    segments,
    markers,
    nativeCalls,
    aws,
    snapshot,
    options: { ...options, expectedSha256 },
    binding,
  };
}

test("native preparation binds two distinct drafts with the same owner without a manifest hash cycle", async () => {
  const f = await fixture();
  expect(
    parseProductionManifest(f.m, f.options.expectedSha256).pausedDrafts,
  ).toEqual(f.binding);
  const captured = JSON.parse(f.objects.get(f.binding.capture.key));
  expect(captured).not.toHaveProperty("manifestSha256");
  expect(captured).not.toHaveProperty("markers");
  const evidence = await collectPausedDrafts({
    ...f.options,
    m: f.m,
    snapshot: f.snapshot,
    validUntil: 1050,
  });
  const result = classifyProductionWork(f.snapshot, {
    binding: f.m.binding,
    uploads: [],
    pausedDrafts: evidence,
  });
  expect(result.counts).toEqual({
    active: 0,
    portable: 0,
    blocked: 0,
    retained: 4,
  });
  expect(result.retained.map((row) => row.disposition)).toEqual(
    Array(4).fill("paused"),
  );
  const reads = f.nativeCalls.filter(
    (c) => c.input.TableName === f.m.controlTableArn,
  );
  expect(reads).toHaveLength(2);
  expect(reads.every((c) => c.input.ConsistentRead === true)).toBe(true);
  const forged = JSON.parse(JSON.stringify(evidence));
  expect(
    classifyProductionWork(f.snapshot, {
      binding: f.m.binding,
      uploads: [],
      pausedDrafts: forged,
    }).counts.blocked,
  ).toBe(4);
});

test.each([
  [
    "duplicate upload",
    ({ options }) => {
      options.identities[1].uploadId = options.identities[0].uploadId;
    },
  ],
  [
    "wrong owner",
    ({ parents }) => {
      parents[0].ownerUserId = "foreign";
    },
  ],
  [
    "processing",
    ({ parents }) => {
      parents[0].status = "processing";
    },
  ],
  [
    "old claim",
    ({ parents }) => {
      parents[0].processingClaimId = "old";
    },
  ],
  [
    "attempts",
    ({ parents }) => {
      parents[0].attempts = 1;
    },
  ],
  [
    "artifact effects",
    ({ parents }) => {
      parents[0].artifactAttempts = {};
    },
  ],
  [
    "duplicate segment",
    ({ segments }) => {
      segments.push({ ...segments[0] });
    },
  ],
  [
    "foreign segment",
    ({ segments }) => {
      segments[0].ownerUserId = "foreign";
    },
  ],
  [
    "unknown source",
    ({ segments }) => {
      segments[0].sourceId = "foreign";
    },
  ],
  [
    "wrong segment key",
    ({ segments }) => {
      segments[0].segmentKey = "wrong";
    },
  ],
  [
    "foreign object key",
    ({ segments }) => {
      segments[0].sourceS3Key = "private-foreign-key";
    },
  ],
  [
    "processing segment",
    ({ segments }) => {
      segments[0].status = "processing";
    },
  ],
  [
    "wrong store",
    ({ options }) => {
      options.storageBinding.storeId = "other";
    },
  ],
  [
    "wrong region",
    ({ options }) => {
      options.storageBinding.region = "us-west-2";
    },
  ],
  [
    "wrong account",
    ({ options }) => {
      options.storageBinding.accountId = "999999999999";
    },
  ],
])(
  "preparation refuses %s before retaining a certificate",
  async (_name, configure) => {
    await expect(fixture(configure)).rejects.toThrow(
      /^UNKNOWN: paused draft preparation/,
    );
  },
);

function collect(f, extra = {}) {
  return collectPausedDrafts({
    ...f.options,
    m: f.m,
    snapshot: f.snapshot,
    validUntil: 1050,
    ...extra,
  });
}

test.each([
  ["missing marker", (f) => f.markers.clear()],
  [
    "wrong marker owner",
    (f) => {
      f.markers.values().next().value.ownerUserId = "foreign";
    },
  ],
  [
    "wrong marker key",
    (f) => {
      f.markers.values().next().value.pk = "UPLOAD#foreign";
    },
  ],
  [
    "wrong marker operation",
    (f) => {
      f.markers.values().next().value.operationId = "foreign";
    },
  ],
  [
    "wrong marker manifest",
    (f) => {
      f.markers.values().next().value.manifestSha256 = "b".repeat(64);
    },
  ],
  [
    "wrong marker capture",
    (f) => {
      f.markers.values().next().value.preservedCaptureSha256 = "b".repeat(64);
    },
  ],
  [
    "malformed marker",
    (f) => {
      f.markers.values().next().value.ttl = 9999;
    },
  ],
  [
    "future marker",
    (f) => {
      f.markers.values().next().value.createdAt = 1001;
    },
  ],
  ["missing parent", (f) => f.parents.shift()],
  [
    "changed parent",
    (f) => {
      f.parents[0].status = "queued";
    },
  ],
  [
    "processing claim",
    (f) => {
      f.parents[0].processingClaimId = "late";
    },
  ],
  [
    "source manifest drift",
    (f) => {
      f.parents[0].sourceManifest[0].label = "Changed";
    },
  ],
  ["missing segment", (f) => f.segments.shift()],
  [
    "extra segment",
    (f) =>
      f.segments.push({
        ...f.segments[0],
        sequence: 1,
        segmentKey: "mic#000001",
        sourceS3Key: f.parents[0].sourceS3Key + "mic-000001.wav",
      }),
  ],
  ["duplicate segment", (f) => f.segments.push({ ...f.segments[0] })],
  [
    "changed segment",
    (f) => {
      f.segments[0].durationMillis = 2000;
    },
  ],
  [
    "scan drift",
    (f) => {
      f.snapshot.tables.uploads[0].updatedAt = "changed";
    },
  ],
  ["scan missing segment", (f) => f.snapshot.tables.segments.shift()],
  [
    "scan extra segment",
    (f) =>
      f.snapshot.tables.segments.push({
        ...f.snapshot.tables.segments[0],
        segmentKey: "extra",
      }),
  ],
])(
  "observation refuses %s instead of safe preservation",
  async (_name, change) => {
    const f = await fixture();
    change(f);
    await expect(collect(f)).rejects.toThrow(
      /^UNKNOWN: paused draft native binding unavailable$/,
    );
  },
);

test.each([
  [
    "operation",
    (m) => {
      m.binding.operationId = "11111111-1111-4111-8111-111111111111";
    },
  ],
  [
    "source",
    (m) => {
      m.binding.sourceSha = "f".repeat(40);
    },
  ],
  [
    "environment",
    (m) => {
      m.environment = "rehearsal";
    },
  ],
  [
    "store",
    (m) => {
      m.evidenceStoreId = "foreign";
    },
  ],
  [
    "table",
    (m) => {
      m.binding.tableArns.segments += "Other";
    },
  ],
  [
    "control table",
    (m) => {
      m.controlTableArn += "Other";
    },
  ],
  [
    "capture version",
    (m) => {
      m.pausedDrafts.capture.versionId = "other";
    },
  ],
  [
    "null capture version",
    (m) => {
      m.pausedDrafts.capture.versionId = "null";
    },
  ],
  [
    "capture key",
    (m) => {
      m.pausedDrafts.capture.key += "other";
    },
  ],
  [
    "capture size",
    (m) => {
      m.pausedDrafts.capture.size++;
    },
  ],
  [
    "capture hash",
    (m) => {
      m.pausedDrafts.capture.sha256 = "0".repeat(64);
    },
  ],
  [
    "cohort owner",
    (m) => {
      m.pausedDrafts.identities[0].ownerUserId = "other";
    },
  ],
  [
    "verified flag",
    (m) => {
      m.pausedDrafts.verified = true;
    },
  ],
])("observation refuses foreign %s binding", async (_name, change) => {
  const f = await fixture();
  change(f.m);
  await expect(
    collect(f, { expectedSha256: manifestHash(f.m) }),
  ).rejects.toThrow(/^UNKNOWN/);
});

test.each([
  ["null object version", (head) => ({ ...head, VersionId: "null" })],
  ["wrong object version", (head) => ({ ...head, VersionId: "other" })],
  ["wrong object size", (head) => ({ ...head, ContentLength: 8 })],
  ["wrong object checksum", (head) => ({ ...head, ChecksumSHA256: "bad" })],
  [
    "missing object checksum",
    (head) => ({ ...head, ChecksumSHA256: undefined }),
  ],
])("observation refuses %s", async (_name, change) => {
  const f = await fixture();
  const aws = async (service, operation, input, options) => {
    const result = await f.aws(service, operation, input, options);
    return operation === "head-object" ? change(result) : result;
  };
  await expect(collect(f, { aws })).rejects.toThrow(/^UNKNOWN/);
});

test("complete query pagination follows empty pages and exact consistent scope", async () => {
  const f = await fixture(({ options, aws }) => {
    options.aws = async (service, operation, input, transport) => {
      if (operation !== "query")
        return aws(service, operation, input, transport);
      expect(input.ConsistentRead).toBe(true);
      if (!input.ExclusiveStartKey)
        return {
          Items: [],
          LastEvaluatedKey: marshall({
            uploadId: input.ExpressionAttributeValues[":uploadId"].S,
            segmentKey: "page-1",
          }),
        };
      return aws(service, operation, input, transport);
    };
  });
  expect(f.binding.capture.versionId).toBe("v1");
  expect(await collect(f)).toBeDefined();
});

test.each([
  "repeated cursor",
  "page limit",
  "row limit",
  "missing items",
  "read failure",
  "expired read",
])("bounded preparation refuses %s", async (fault) => {
  await expect(
    fixture(({ options, aws }) => {
      if (fault === "page limit") options.manifest.maxPages = 1;
      if (fault === "row limit") options.manifest.maxRows = 1;
      options.expectedSha256 = manifestHash(options.manifest);
      let time = 1000;
      options.now = () => time;
      options.aws = async (service, operation, input, transport) => {
        expect(transport.signal).toBeDefined();
        if (operation !== "query")
          return aws(service, operation, input, transport);
        const result = await aws(service, operation, input, transport);
        if (fault === "read failure")
          throw new Error("private provider locator");
        if (fault === "expired read") {
          time = 6000;
          return result;
        }
        if (fault === "missing items") return {};
        if (fault === "row limit")
          return { Items: [...result.Items, ...result.Items] };
        return {
          ...result,
          LastEvaluatedKey: marshall({
            uploadId: input.ExpressionAttributeValues[":uploadId"].S,
            segmentKey: "same",
          }),
        };
      };
    }),
  ).rejects.toThrow(
    /^UNKNOWN: paused draft preparation unavailable; do not retry uncertain capture$/,
  );
});

test("absent optional binding performs no native acquisition", async () => {
  const f = privateCaptureFixture();
  expect(await collectPausedDrafts({ m: f.m })).toBeUndefined();
});
import { jest } from "@jest/globals";
import { createTrustedCollector } from "../../scripts/deployment/trusted-collector.cjs";
import { collectNativeInventory } from "../../scripts/deployment/collector-inventory.cjs";
import { renderCollector } from "../../scripts/deployment/collector-command.cjs";
import { buildProbeRequests } from "../../scripts/deployment/maintenance-probe.cjs";
import { createEvidenceCollector } from "../../scripts/deployment/production-evidence.cjs";
import { evidenceFixture } from "../fixtures/deployment/productionIntroduction.js";
import { assertProductionDrain } from "../../scripts/deployment/production-work.cjs";
jest.mock("../../scripts/deployment/collector-inventory.cjs", () => ({
  ...jest.requireActual("../../scripts/deployment/collector-inventory.cjs"),
  collectNativeInventory: jest.fn(),
}));

test("trusted collector retains acquired compatibility but still refuses all global prerequisites", async () => {
  const f = await fixture();
  collectNativeInventory.mockResolvedValueOnce({
    tasks: { bound: { lastStatus: "STOPPED" } },
  });
  const collector = createTrustedCollector({
    ...f.options,
    storageBinding: f.binding && f.options.storageBinding,
  });
  const request = renderCollector(f.m, {
    nonce: f.m.binding.operationId,
    operationId: f.m.binding.operationId,
    manifestSha256: f.options.expectedSha256,
    roleArn: f.m.binding.taskRoleArn,
    phase: "drain",
    snapshotSha256: manifestHash(f.snapshot),
    probeRequestsSha256: manifestHash(buildProbeRequests(f.m.binding)),
    validUntil: 1050,
  }).request;
  const error = await collector(request, f.snapshot).catch((error) => error);
  expect(error.code).toBe("collector_prerequisites_unavailable");
  expect(error.blockers).toEqual(
    expect.arrayContaining([
      "external_effect_settlement_unproved",
      "cached_application_credentials_unproved",
      "immutable_objects_tokens_schema_compatibility_unproved",
      "row_bound_uploads_settlement_unproved",
      "row_bound_segments_settlement_unproved",
    ]),
  );
  const retained = await collector.readCapture(error.capture);
  expect(retained.compatibility.pausedDrafts.capture).toEqual(
    f.binding.capture,
  );
  expect(retained.compatibility.pausedDrafts.limitations).toContain(
    "audio_bytes_unproved",
  );
});

test.each([false, true])(
  "two-round proof binds acquired cohort and refuses marker drift=%s",
  async (drift) => {
    const f = await fixture();
    const e = evidenceFixture(f.m),
      original = e.options.probe;
    e.options.aws = f.aws;
    let rounds = 0;
    e.options.probe = Object.assign(async (request, snapshot) => {
      const proof = await original(request);
      if (++rounds === 2 && drift) f.markers.values().next().value.createdAt++;
      proof.compatibility.pausedDrafts = await collect(f, {
        snapshot,
        validUntil: proof.validUntil,
      });
      return proof;
    }, original);
    const context = {
      predecessorSha256: null,
      taskArn: f.m.legacyTaskArn,
      taskDefinition: f.m.legacyTaskDefinition,
      sourceSha: f.m.binding.legacySha,
      owned: true,
    };
    const pending = createEvidenceCollector(e.options).drain(context);
    if (drift)
      await expect(pending).rejects.toThrow("Observation state changed");
    else
      expect(
        (await pending).rounds[1].proof.compatibility.pausedDrafts.parents,
      ).toHaveLength(2);
  },
);

test("drain cannot outlive the acquired pause evidence", async () => {
  const f = await fixture();
  const pausedDrafts = await collect(f);
  const barrier = {
    binding: f.m.binding,
    owners: [],
    evidenceId: "synthetic",
    admission: "closed",
    effects: "settled",
    fencedAt: 1000,
    checkedAt: 1051,
    validUntil: 2000,
    revisionBefore: "same",
    revisionAfter: "same",
  };
  expect(() =>
    assertProductionDrain(
      {
        snapshot: f.snapshot,
        compatibility: { binding: f.m.binding, uploads: [], pausedDrafts },
        barrier,
        now: 1051,
      },
      f.m.binding,
    ),
  ).toThrow("Expired compatibility evidence");
});

function changeCapture(f, change) {
  const original = JSON.parse(f.objects.get(f.binding.capture.key));
  change(original);
  const bytes = Buffer.from(JSON.stringify(original));
  const ref = f.binding.capture;
  ref.sha256 = manifestHash(original);
  ref.size = bytes.length;
  ref.key = ref.namespace + "/" + ref.sha256;
  f.objects.set(ref.key, bytes);
  f.options.expectedSha256 = manifestHash(f.m);
  for (const marker of f.markers.values()) {
    marker.manifestSha256 = f.options.expectedSha256;
    marker.preservedCaptureSha256 = ref.sha256;
  }
}

test.each([
  [
    "foreign object key",
    (value) => {
      value.objects[0].key = "foreign-private-key";
    },
  ],
  [
    "null version",
    (value) => {
      value.objects[0].versionId = "null";
    },
  ],
  [
    "absent version",
    (value) => {
      delete value.objects[0].versionId;
    },
  ],
  [
    "wrong upload",
    (value) => {
      value.objects[0].uploadId = "foreign";
    },
  ],
  [
    "wrong owner",
    (value) => {
      value.objects[0].ownerUserId = "foreign";
    },
  ],
  [
    "extra object",
    (value) => {
      value.objects.push({ ...value.objects[0], key: "foreign" });
    },
  ],
])("captured %s refuses before an object request", async (_name, change) => {
  const f = await fixture();
  changeCapture(f, change);
  f.nativeCalls.length = 0;
  await expect(collect(f)).rejects.toThrow(/^UNKNOWN/);
  expect(
    f.nativeCalls.filter((call) => call.operation === "head-object"),
  ).toHaveLength(0);
});
import { rehearsalFixture } from "../fixtures/deployment/rehearsalIntroduction.js";
import { parseRehearsalManifest } from "../../scripts/deployment/rehearsal-manifest.cjs";
import { parseManifest as parseSandboxManifest } from "../../scripts/deployment/sandbox-manifest.cjs";

test("exact rehearsal profile supports the same cohort path while Sandbox remains strict", async () => {
  const f = await fixture(({ options }) => {
    const rehearsal = rehearsalFixture();
    Object.assign(options.manifest, rehearsal);
    options.expectedSha256 = manifestHash(options.manifest);
  });
  expect(
    parseRehearsalManifest(f.m, f.options.expectedSha256).pausedDrafts,
  ).toEqual(f.binding);
  expect(f.binding.capture.namespace).toMatch(
    /^rehearsal-introduction-preparation\//,
  );
  expect(await collect(f)).toBeDefined();
  expect(() => parseSandboxManifest(f.m, f.options.expectedSha256)).toThrow();
});

test("only manifest and segment object keys are headed, with exact captured versions on observation", async () => {
  const f = await fixture(({ parents }) => {
    for (const parent of parents)
      Object.assign(parent.sourceManifest[0], {
        sourceS3Key: parent.sourceS3Key + "original.wav",
        contentType: "audio/wav",
        fileSize: 4,
      });
  });
  f.nativeCalls.length = 0;
  await collect(f);
  const heads = f.nativeCalls.filter(
    (call) => call.operation === "head-object",
  );
  expect(heads).toHaveLength(4);
  expect(
    heads.every(
      (call) =>
        call.input.VersionId === "audio-v1" &&
        call.input.ExpectedBucketOwner === f.m.binding.accountId,
    ),
  ).toBe(true);
  expect(heads.every((call) => !call.input.Key.endsWith("/"))).toBe(true);
  const queries = f.nativeCalls.filter((call) => call.operation === "query");
  expect(
    queries.every(
      (call) =>
        call.input.ConsistentRead &&
        call.input.TableName === f.m.binding.tableArns.segments,
    ),
  ).toBe(true);
  const parents = f.nativeCalls.filter(
    (call) => call.input.TableName === f.m.binding.tableArns.uploads,
  );
  for (const call of parents) {
    const fields = Object.values(call.input.ExpressionAttributeNames);
    expect(fields).toContain("sourceManifest");
    for (const field of ["title", "tags", "errorMessage"])
      expect(fields).not.toContain(field);
  }
});

test("a parent source object absent from both manifest and segments cannot be preserved implicitly", async () => {
  await expect(
    fixture(({ parents }) => {
      parents[0].sourceS3Key += "unbound.wav";
    }),
  ).rejects.toThrow(/^UNKNOWN/);
});

test.each([
  "environment",
  "operationId",
  "sourceSha",
  "evidenceStoreId",
  "controlTableArn",
  "uploadTableArn",
  "segmentTableArn",
  "accountId",
  "region",
  "bucket",
])(
  "captured %s join refuses even when its bytes and final marker hashes are authentic",
  async (field) => {
    const f = await fixture();
    changeCapture(f, (value) => {
      value.binding[field] = "foreign";
    });
    f.nativeCalls.length = 0;
    await expect(collect(f)).rejects.toThrow(/^UNKNOWN/);
    expect(f.nativeCalls).toHaveLength(0);
  },
);

test.each([
  "parent drift",
  "segment drift",
  "terminal parent",
  "terminal segment",
  "expired",
  "cloned",
])(
  "bound cohort refuses ordinary compatibility after %s while unrelated work stays portable",
  async (fault) => {
    const f = await fixture(({ parents }) => {
      for (const parent of parents) parent.fileSize = 4;
    });
    let pausedDrafts = await collect(f);
    const originalParent = { ...f.parents[1] },
      originalSegment = { ...f.segments[1] };
    const ordinaryId = "unbound-upload";
    f.parents.push({ ...originalParent, uploadId: ordinaryId });
    f.segments.push({ ...originalSegment, uploadId: ordinaryId });
    if (fault === "parent drift") f.parents[0].updatedAt = "changed";
    if (fault === "segment drift") f.segments[0].updatedAt = "changed";
    if (fault === "terminal parent") f.parents[0].status = "complete";
    if (fault === "terminal segment") f.segments[0].status = "processed";
    if (fault === "cloned")
      pausedDrafts = JSON.parse(JSON.stringify(pausedDrafts));
    const snapshot = await scanProductionWork(f.aws, {
      binding: f.m.binding,
      observedAt: fault === "expired" ? 1051 : 1001,
      owners: [],
    });
    const compatibility = {
      binding: f.m.binding,
      pausedDrafts,
      uploads: snapshot.tables.uploads.map((row) => ({
        uploadId: row.uploadId,
        rowDigest: manifestHash(row),
        sourceInput: "verified",
        token: "verified",
        schema: "verified",
        ownership: "verified",
        claimProtocol: "verified",
        evidenceId: "ordinary-current-row-evidence",
        validUntil: 2000,
        segmentDigests: snapshot.tables.segments
          .filter((segment) => segment.uploadId === row.uploadId)
          .map(manifestHash),
      })),
    };
    for (const table of ["uploads", "segments"])
      snapshot.settlements.push(
        ...snapshot.tables[table].map((row) => ({
          table,
          rowDigest: manifestHash(row),
          effects: "acknowledged",
          evidenceId: "ordinary-settlement",
        })),
      );
    const result = classifyProductionWork(snapshot, compatibility);
    expect(result.counts).toEqual({
      active: 0,
      portable: 2,
      blocked: 4,
      retained: 0,
    });
    expect(result.blocked.map((entry) => entry.key.uploadId).sort()).toEqual([
      "draft-a",
      "draft-a",
      "draft-b",
      "draft-b",
    ]);
    expect(
      result.portable.every((entry) => entry.key.uploadId === ordinaryId),
    ).toBe(true);
    expect(result.retained).toHaveLength(0);
    expect(f.parents[1]).toEqual(originalParent);
    expect(f.segments[1]).toEqual(originalSegment);
  },
);

test("preparation bounds the entire cohort including source-manifest objects", async () => {
  await expect(
    fixture(({ parents, options }) => {
      options.manifest.maxRows = 4;
      options.expectedSha256 = manifestHash(options.manifest);
      parents[0].sourceManifest.push({
        sourceId: "system",
        kind: "system_output",
        label: "Output",
      });
    }),
  ).rejects.toThrow(/^UNKNOWN/);
});
