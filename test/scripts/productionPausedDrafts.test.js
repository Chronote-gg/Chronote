/** @jest-environment node */
import { preparationSegment } from "../fixtures/productionPausedPreparation.js";
import { expect, jest, test, afterEach } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  bound,
  fixture as manifestFixture,
} from "../fixtures/productionManifest.js";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { scopeFor } from "../../scripts/deployment/production-paused-contract.cjs";
jest.mock(
  "../../scripts/deployment/production-paused-draft-binding.cjs",
  () => ({
    readDraftBinding: (binding) => {
      jest
        .requireActual("../../scripts/deployment/production-manifest.cjs")
        .assertBoundExecution(binding, Math.floor(Date.now() / 1000));
      return {
        manifest: binding.manifest,
        manifestHash: binding.manifestHash,
        actor: binding.actor,
        purpose: "introduction",
      };
    },
    readAuthenticatedPausedPreparation: (token) => {
      if (!token?.native) throw Error("preparation_prerequisite");
      return token.native;
    },
  }),
);
const mockSettings = Object.freeze({});
jest.mock("../../scripts/deployment/production-launcher-settings.cjs", () => ({
  readPausedEffectivePolicyScope: (token) => {
    if (token !== mockSettings) throw Error("settings_refused");
    return { scopeSha256: "f".repeat(64) };
  },
}));
import {
  bindOriginalPausedDisposition,
  collectPausedDraftMetadata,
  assertInstallablePausedCohort,
  readPausedCohort,
} from "../../scripts/deployment/production-paused-drafts.cjs";

function fixture() {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const m0 = manifestFixture();
  m0.operationId = "00000000-0000-4000-8000-000000000001";
  const binding = bound(m0);
  const m = binding.manifest;
  const scope = scopeFor(m);
  const cohort = ["one", "two"].map((uploadId) => ({
    uploadId,
    ownerUserId: "owner",
    sourceCount: 1,
  }));
  const parents = cohort.map(({ uploadId, ownerUserId }) => ({
    uploadId,
    ownerUserId,
    status: "pending_upload",
    mediaKind: "audio",
    uploadOrigin: "desktop_recording",
    sourceS3Key: `${uploadId}/`,
    sourceManifest: [{ sourceId: "mic", kind: "owner_mic" }],
    contentType: "audio/wav",
    fileSize: 0,
    createdAt: "before",
    updatedAt: "before",
    segmentCount: 1,
    uploadedSegmentCount: 1,
  }));
  const segments = cohort.map((id) => {
    const { label, ...segment } = preparationSegment(id, `${id.uploadId}/0`);
    void label;
    return { ...segment, segmentKey: "mic#0" };
  });
  const objects = segments.map((r) => ({
    uploadId: r.uploadId,
    ownerUserId: r.ownerUserId,
    key: r.sourceS3Key,
    size: r.fileSize,
    contentType: r.contentType,
    versionId: "v1",
    checksums: {},
    checksumType: "unavailable",
  }));
  const provenance = {
    repository: "Chronote-gg/Chronote",
    repositoryId: "1",
    repositoryOwnerId: "2",
    workflow: ".github/workflows/prepare-production-paused-drafts.yml",
    jobName: "Prepare production paused drafts",
    runId: "20",
    runAttempt: "1",
    sourceCommit: m.identity.sourceCommit,
    actorId: "123",
    validFrom: 100,
    validUntil: 200,
  };
  const capture = {
    schemaVersion: 1,
    predicate: "preserve-two-desktop-drafts-v1",
    requestSha256: "a".repeat(64),
    scope,
    cohort,
    parents,
    segments,
    objects,
    storageObservations: {
      observedAt: 150,
      personalJobTtl: {
        TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" },
      },
      personalSegmentTtl: {
        TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" },
      },
      personalJobKmsKeyArn: "key",
      personalSegmentKmsKeyArn: "key",
      bucketVersioning: { Status: "Enabled" },
      bucketLifecycle: { Rules: [] },
    },
    preparation: {
      ...provenance,
      accountId: m.identity.accountId,
      sessionArn: "synthetic",
      roleArn: "synthetic",
    },
  };
  const declaration = {
    predicate: "preserve-two-desktop-drafts-v1",
    scope,
    cohort,
    request: { commit: "b".repeat(40), sha256: capture.requestSha256 },
    preparation: { ...provenance, artifactId: "30" },
    capture: {
      storeId: "private",
      namespace: "private",
      key: "private",
      sha256: canonicalHash(capture),
      size: 100,
      versionId: "v1",
    },
    storeBinding: {
      kind: "versioned-private-s3-v1",
      storeId: "private",
      bucket: "private-evidence",
      accountId: m.identity.accountId,
      region: m.identity.region,
      kmsKeyArn: `arn:aws:kms:${m.identity.region}:${m.identity.accountId}:key/00000000-0000-0000-0000-000000000001`,
      policySha256: "a".repeat(64),
      lifecycleSha256: "a".repeat(64),
      retentionUntil: 300,
      administratorTrustSha256: "a".repeat(64),
    },
  };
  const evidence = {
    retainedDisposition: { pausedDesktopDrafts: declaration },
  };
  const preparation = {
    native: {
      declaration,
      capture,
      manifestHash: binding.manifestHash,
      actor: "123",
      validUntil: 200,
    },
  };
  const readers = {
    read: jest.fn(async () => undefined),
    pausedDraftMetadata: jest.fn(async (_token, _settings, request) => {
      if (request.kind === "parent")
        return {
          Items: parents
            .filter((r) => r.uploadId === request.uploadId)
            .map(marshall),
        };
      if (request.kind === "segments")
        return {
          Items: segments
            .filter((r) => r.uploadId === request.uploadId)
            .map(marshall),
        };
      if (request.kind === "object") {
        const o = objects.find((o) => o.key === request.key);
        return {
          VersionId: o.versionId,
          ContentLength: o.size,
          ContentType: o.contentType,
        };
      }
      if (request.kind === "tableTtl")
        return { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } };
      if (request.kind === "bucketVersioning") return { Status: "Enabled" };
      if (request.kind === "bucketLifecycle")
        return {
          Rules: [
            {
              Status: "Enabled",
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
          ],
        };
      throw Error("unexpected read");
    }),
  };
  const snapshot = {
    observedAt: 150,
    coverage: ["personalJob", "personalSegment", "meetingHistory"].map(
      (table) => ({ table, status: "enumerated" }),
    ),
    records: [
      ...parents.map((r) => ({
        table: "personalJob",
        key: { uploadId: r.uploadId },
        metadata: {
          uploadId: r.uploadId,
          ownerUserId: r.ownerUserId,
          status: r.status,
          segmentCount: 1,
          uploadedSegmentCount: 1,
        },
      })),
      ...segments.map((r) => ({
        table: "personalSegment",
        key: { uploadId: r.uploadId, segmentKey: r.segmentKey },
        metadata: {
          uploadId: r.uploadId,
          ownerUserId: r.ownerUserId,
          segmentKey: r.segmentKey,
          sourceId: r.sourceId,
          sequence: r.sequence,
          status: r.status,
          checksumSha256: r.checksumSha256,
          durationMillis: r.durationMillis,
          uploadedAt: r.uploadedAt,
        },
      })),
    ],
  };
  return { binding, evidence, preparation, readers, snapshot, capture };
}
function bindFixture(f) {
  return bindOriginalPausedDisposition(f.binding, f.evidence, f.preparation);
}
async function acquireFixture(f) {
  return collectPausedDraftMetadata(
    bindFixture(f),
    f.readers,
    "before_stop",
    mockSettings,
  );
}
afterEach(() => jest.restoreAllMocks());
test("acquires only original two drafts without content and labels optional checksum UNKNOWN", async () => {
  const f = fixture();
  const acquired = await acquireFixture(f);
  expect(assertInstallablePausedCohort(acquired, f.snapshot)).toBeDefined();
  const installable = acquired;
  const view = readPausedCohort(installable, "before_stop");
  expect(view.objects).toHaveLength(2);
  expect(view.checksumEvidence).toBe("UNKNOWN");
  expect(
    f.readers.pausedDraftMetadata.mock.calls
      .filter(([, , r]) => r.kind === "object")
      .map(([, , r]) => r.key),
  ).toEqual(["one/0", "two/0"]);
  expect(() => readPausedCohort({ ...installable }, "before_stop")).toThrow();
});
test.each([
  "processingClaimId",
  "completedAt",
  "meetingId",
  "artifactAttempts",
])("forbidden parent %s refuses", async (field) => {
  const f = fixture();
  f.capture.parents[0][field] = "unexpected";
  await expect(acquireFixture(f)).rejects.toThrow();
});
test("reverse personal history link and missing global segment refuse", async () => {
  const f = fixture();
  const acquired = await acquireFixture(f);
  f.snapshot.records.push({
    table: "meetingHistory",
    key: { guildId: "x", channelId_timestamp: "y" },
    metadata: { canonicalWriter: { uploadId: "one" } },
  });
  expect(() => assertInstallablePausedCohort(acquired, f.snapshot)).toThrow();
  f.snapshot.records.pop();
  f.snapshot.records.pop();
  expect(() => assertInstallablePausedCohort(acquired, f.snapshot)).toThrow();
});
test("missing object version, source membership and cyclic pagination refuse", async () => {
  for (const change of [
    (f) => {
      f.capture.objects[0].versionId = "null";
    },
    (f) => {
      f.capture.parents[0].sourceManifest[0].sourceId = "other";
    },
    (f) => {
      f.readers.pausedDraftMetadata.mockImplementation(async () => ({
        Items: [],
        LastEvaluatedKey: marshall({ uploadId: "one" }),
      }));
    },
  ]) {
    const f = fixture();
    change(f);
    await expect(acquireFixture(f)).rejects.toThrow();
  }
});
test("original actor domains, declaration and execution identity fail independently", () => {
  for (const mutate of [
    (f) => {
      f.preparation.native.actor = "999";
    },
    (f) => {
      f.binding.actor = "arn:wrong";
    },
    (f) => {
      f.preparation.native.manifestHash = "f".repeat(64);
    },
    (f) => {
      f.evidence.retainedDisposition.pausedDesktopDrafts = structuredClone(
        f.evidence.retainedDisposition.pausedDesktopDrafts,
      );
      f.evidence.retainedDisposition.pausedDesktopDrafts.scope.operationId =
        "other";
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(() => bindFixture(f)).toThrow();
  }
});
test("tokens are phase-specific and expire during asynchronous metadata collection", async () => {
  const f = fixture(),
    token = bindFixture(f);
  expect(() => assertInstallablePausedCohort(token, f.snapshot)).toThrow();
  f.readers.pausedDraftMetadata.mockImplementation(async () => {
    Date.now.mockReturnValue(200000);
    return { Items: [] };
  });
  await expect(
    collectPausedDraftMetadata(token, f.readers, "before_stop", mockSettings),
  ).rejects.toThrow();
});
test("lifecycle deletion, active TTL and checksum mutation refuse", async () => {
  for (const mutate of [
    (request, result) =>
      request.kind === "tableTtl"
        ? { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" } }
        : result,
    (request, result) =>
      request.kind === "bucketLifecycle"
        ? {
            Rules: [
              {
                Status: "Enabled",
                Expiration: { Days: 1 },
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
              },
            ],
          }
        : result,
    (request, result) =>
      request.kind === "object"
        ? { ...result, VersionId: "new-version" }
        : result,
  ]) {
    const f = fixture(),
      read = f.readers.pausedDraftMetadata.getMockImplementation();
    f.readers.pausedDraftMetadata.mockImplementation(
      async (token, settings, request) =>
        mutate(request, await read(token, settings, request)),
    );
    const token = bindFixture(f);
    await expect(
      collectPausedDraftMetadata(token, f.readers, "before_stop", mockSettings),
    ).rejects.toThrow();
  }
});
test("complete capture metadata cannot carry omitted content", () => {
  const f = fixture();
  f.capture.parents[0].title = "private text";
  expect(() => bindFixture(f)).toThrow();
});
test("native disabled bucket keys do not fill missing saved attestation", async () => {
  const f = fixture();
  f.capture.objects[0].encryption = {
    serverSideEncryption: "aws:kms",
    sseKmsKeyId: "exact-key",
  };
  const normal = f.readers.pausedDraftMetadata.getMockImplementation();
  f.readers.pausedDraftMetadata.mockImplementation(async (...args) => {
    const result = await normal(...args);
    if (args[2].kind === "object")
      Object.assign(result, {
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: "exact-key",
        BucketKeyEnabled: false,
      });
    return result;
  });
  await expect(acquireFixture(f)).rejects.toThrow();
  expect(f.capture.objects[0].encryption).not.toHaveProperty(
    "bucketKeyEnabled",
  );
});

test.each([undefined, false, true, null, "false", 0])(
  "paused runtime validates native bucket-key metadata %p against attested false",
  async (bucketKey) => {
    const f = fixture();
    f.capture.objects[0].encryption = {
      serverSideEncryption: "aws:kms",
      sseKmsKeyId: "exact-key",
      bucketKeyEnabled: false,
    };
    const normal = f.readers.pausedDraftMetadata.getMockImplementation();
    f.readers.pausedDraftMetadata.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (args[2].kind === "object") {
        result.ServerSideEncryption = "aws:kms";
        result.SSEKMSKeyId = "exact-key";
        if (bucketKey !== undefined) result.BucketKeyEnabled = bucketKey;
      }
      return result;
    });
    const operation = acquireFixture(f);
    if (bucketKey === undefined || bucketKey === false)
      await expect(operation).resolves.toBeDefined();
    else await expect(operation).rejects.toThrow();
  },
);

test("encrypted object identity is preserved when the original capture declares it", async () => {
  const f = fixture();
  f.capture.objects[0].encryption = {
    serverSideEncryption: "aws:kms",
    sseKmsKeyId: "exact-key",
  };
  const token = bindFixture(f);
  await expect(
    collectPausedDraftMetadata(token, f.readers, "before_stop", mockSettings),
  ).rejects.toThrow();
});

test("required checksum predicates retain their approved source and cannot be weakened", async () => {
  const f = fixture();
  f.capture.objects[0].requiredChecksums = {
    ChecksumSHA256: { value: "approved", source: "original-approval-sha256" },
  };
  const token = bindFixture(f);
  await expect(
    collectPausedDraftMetadata(token, f.readers, "before_stop", mockSettings),
  ).rejects.toThrow();
});
test("each selected draft requires actual preserved bytes", () => {
  const f = fixture();
  f.capture.objects.pop();
  expect(() => bindFixture(f)).toThrow();
});

test.each([
  { checksums: { VersionId: "v1" } },
  {
    checksums: { ChecksumSHA256: "captured" },
    requiredChecksums: {
      ChecksumSHA256: { value: "other", source: "approved" },
    },
  },
])(
  "rejects arbitrary checksum fields and conflicting predicates: %j",
  (checksum) => {
    const f = fixture();
    Object.assign(f.capture.objects[0], checksum);
    expect(() => bindFixture(f)).toThrow();
  },
);

test("unsupported encryption cannot bypass the fixed KMS permission profile", () => {
  const f = fixture();
  f.capture.objects[0].encryption = {
    serverSideEncryption: "aws:kms:dsse",
    sseKmsKeyId: "key",
  };
  expect(() => bindFixture(f)).toThrow();
});
