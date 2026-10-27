/** @jest-environment node */
import { Buffer } from "node:buffer";
import { jest, test, expect, beforeEach, afterEach } from "@jest/globals";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { contentFixture } from "../fixtures/productionFixtureContent.js";
import {
  collectGeneratedFixturesFromOriginalRun,
  readGeneratedFixtures,
} from "../../scripts/deployment/production-fixture-content.cjs";
const mockFallback = jest.fn();
const mockLoad = jest.fn(),
  mockRead = jest.fn(),
  mockAws = jest.fn(),
  mockDdb = jest.fn(),
  mockSts = jest.fn(),
  mockS3 = jest.fn(),
  mockSource = jest.fn();
let mockFixture;
jest.mock("../../scripts/deployment/production-private-package.cjs", () => ({
  loadAcceptancePackage: () => mockLoad(),
  verifyOwnershipEvidence: (...args) => mockSource(...args),
}));
jest.mock("../../scripts/deployment/production-aws.cjs", () => ({
  createProductionAws: () => ({
    read: (...args) => mockRead(...args),
    aws: (...args) => mockAws(...args),
  }),
}));
jest.mock("../../scripts/deployment/production-inventory-adapter.cjs", () => ({
  createInventoryReader: () => ({
    definition: async () => ({
      containerDefinitions: [{ name: "app", environment: [] }],
    }),
  }),
}));
jest.mock("../../scripts/deployment/production-source-routes.cjs", () => ({
  verifyDeclaredRoutes: jest.fn(),
  readVerifiedFallbackTemplates: (...args) => mockFallback(...args),
}));
jest.mock("../../scripts/deployment/production-candidate.cjs", () => ({
  ...jest.requireActual("../../scripts/deployment/production-candidate.cjs"),
  createCandidateInspection: () => ({ definitions: async () => undefined }),
}));
jest.mock(
  "../../scripts/deployment/production-acceptance-supplement.cjs",
  () => ({
    ...jest.requireActual(
      "../../scripts/deployment/production-acceptance-supplement.cjs",
    ),
    readPinnedSupplement: async () => ({ value: mockFixture.supplement }),
  }),
);
jest.mock(
  "../../dist/services/productionFixtureAcceptance.js",
  () => jest.requireActual("../../src/services/productionFixtureAcceptance"),
  { virtual: true },
);
jest.mock(
  "../../dist/services/productionFixtureCapture.js",
  () => jest.requireActual("../../src/services/productionFixtureCapture"),
  { virtual: true },
);
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: (command) => mockDdb(command) })),
}));
jest.mock("../../scripts/deployment/coordinator-aws.cjs", () => ({
  awsCli: async (_service, _operation, input) =>
    mockSts({ input, kind: "assume" }),
}));
jest.mock("node:child_process", () => {
  const execFile = () => undefined;
  execFile[Symbol.for("nodejs.util.promisify.custom")] = async (
    _exe,
    _args,
    settings,
  ) => ({
    stdout: JSON.stringify(
      await mockSts(
        { input: {}, kind: "identity" },
        { credentials: { accessKeyId: settings.env.AWS_ACCESS_KEY_ID } },
      ),
    ),
  });
  return { ...jest.requireActual("node:child_process"), execFile };
});
jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn((settings) =>
    jest
      .requireActual("../fixtures/productionProviderFixtures.js")
      .s3Transport(mockS3, settings),
  ),
}));

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(320000);
  mockFixture = contentFixture();
  const f = mockFixture,
    m = f.binding.manifest;
  mockLoad.mockResolvedValue({
    binding: f.binding,
    evidence: {},
    acceptanceContext: { approvedReviewerIds: ["7"] },
  });
  mockSource.mockResolvedValue({});
  mockFallback.mockImplementation((_token, _hash, paths) =>
    paths.map((path) => ({
      sourceCommit: m.identity.sourceCommit,
      path,
      sourceSha256: "c".repeat(64),
    })),
  );
  mockRead.mockImplementation(async ({ pk, sk }) => {
    if (sk === "INTRODUCTION") return f.hold;
    if (sk === "CONTROL") return f.control;
    if (sk === "FIXTURE_COORDINATOR") return f.authority;
    if (sk === "AUTHORITY")
      return f.fixtures.find((item) => item.grant.pk === pk)?.grant;
    return f.fixtures.find((item) => item.runtime.sk === sk)?.runtime;
  });
  mockAws.mockImplementation(async (_service, _operation, { tasks }) => {
    const index = f.fixtures.findIndex(
      (item) => item.runtime.identity.taskArn === tasks[0],
    );
    const identity = f.fixtures[index].runtime.identity;
    return {
      tasks: [
        {
          taskArn: identity.taskArn,
          taskDefinitionArn: index
            ? m.runtime.continuationDefinition
            : m.runtime.candidateDefinition,
          containers: [
            { name: m.runtime.container, imageDigest: identity.imageDigest },
          ],
        },
      ],
      failures: [],
    };
  });
  mockDdb.mockImplementation(async ({ input }) => {
    const key = unmarshall(input.Key);
    const item = f.fixtures.find(
      (value) =>
        value.grant.historyKey.channelId_timestamp === key.channelId_timestamp,
    );
    const row = { ...item.history, notes: item.notes };
    const selected = Object.values(input.ExpressionAttributeNames);
    return {
      Item: marshall(
        Object.fromEntries(selected.map((field) => [field, row[field]])),
      ),
    };
  });
  mockSts.mockImplementation(async (command, settings) => {
    const sessionName =
      command.input.RoleSessionName ?? settings.credentials.accessKeyId;
    const arn = `arn:aws:sts::${m.identity.accountId}:assumed-role/acceptance-reader/${sessionName}`;
    if (command.kind === "identity")
      return { Account: m.identity.accountId, Arn: arn };
    expect(command.input.Policy.length).toBeLessThanOrEqual(2048);
    return {
      AssumedRoleUser: { Arn: arn },
      Credentials: {
        AccessKeyId: sessionName,
        SecretAccessKey: "dummy",
        SessionToken: "dummy",
        Expiration: new Date(3920000).toISOString(),
      },
    };
  });
  mockS3.mockImplementation(async (command, settings) => {
    const index = Number(settings.credentials.accessKeyId.at(-1));
    const item = f.objects.get(command.input.Key);
    expect(command.input.Key).toContain(
      `_${m.handoff.grants[index].meetingId}_`,
    );
    const metadata = {
      ContentLength: item.bytes.length,
      VersionId: item.versionId,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: m.acceptance.storageKeyArn,
      BucketKeyEnabled: false,
    };
    if (command.constructor.name === "HeadObjectCommand") return metadata;
    expect(command.input.VersionId).toBe(item.versionId);
    expect(command.input.ChecksumMode).toBeUndefined();
    return { ...metadata, Body: Readable.from([item.bytes]) };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  [
    mockLoad,
    mockRead,
    mockAws,
    mockDdb,
    mockSts,
    mockS3,
    mockSource,
    mockFallback,
  ].forEach((fn) => fn.mockReset());
});

test("authenticates both metadata gates then uses distinct exact-folder sessions and never follows transcription chunks", async () => {
  const token = await collectGeneratedFixturesFromOriginalRun();
  expect(readGeneratedFixtures(token).fixtures).toHaveLength(2);
  expect(
    readGeneratedFixtures(token).fixtures[0].contents.capture.savedDurationMs,
  ).toBe(200000);
  expect(
    readGeneratedFixtures(token).fixtures[0].contents.historicalHandoff,
  ).toBe("unverified");
  expect(mockLoad).toHaveBeenCalledWith();
  expect(mockSts.mock.calls.filter(([c]) => c.kind === "assume")).toHaveLength(
    2,
  );
  expect(mockS3.mock.calls).toHaveLength(12);
  expect(
    mockS3.mock.calls.some(([c]) => c.input.Key.includes("/transcription/")),
  ).toBe(false);
  expect(mockDdb.mock.invocationCallOrder[1]).toBeLessThan(
    mockSts.mock.invocationCallOrder[0],
  );
  for (const copied of [{}, { ...token }, JSON.parse(JSON.stringify(token))])
    expect(() => readGeneratedFixtures(copied)).toThrow();
  Date.now.mockReturnValue(mockFixture.binding.manifest.validUntil * 1000);
  expect(() => readGeneratedFixtures(token)).toThrow();
});

test.each([undefined, false, true, null, "false", 0])(
  "fixture content validates native bucket-key metadata %p",
  async (bucketKey) => {
    const normal = mockS3.getMockImplementation();
    mockS3.mockImplementation(async (...args) => {
      const result = await normal(...args);
      delete result.BucketKeyEnabled;
      if (bucketKey !== undefined) result.BucketKeyEnabled = bucketKey;
      return result;
    });
    const operation = collectGeneratedFixturesFromOriginalRun();
    if (bucketKey === undefined || bucketKey === false) {
      const token = await operation;
      expect(readGeneratedFixtures(token).fixtures).toHaveLength(2);
    } else await expect(operation).rejects.toThrow();
  },
);

test.each([
  "loader",
  "source",
  "second-grant",
  "second-owner",
  "second-history",
])(
  "refuses %s failures before session issuance or content",
  async (failure) => {
    if (failure === "loader")
      mockLoad.mockRejectedValue(new Error("authentication_refused"));
    if (failure === "source")
      mockSource.mockRejectedValue(new Error("source_refused"));
    if (failure === "second-grant")
      mockFixture.fixtures[1].grant.commandId = "foreign";
    if (failure === "second-owner")
      mockFixture.fixtures[1].runtime.identity.imageDigest =
        "sha256:" + "0".repeat(64);
    if (failure === "second-history")
      mockFixture.fixtures[1].history.fixtureInput.state = "incomplete";
    await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow();
    expect(mockSts).not.toHaveBeenCalled();
    expect(mockS3).not.toHaveBeenCalled();
  },
);

test.each([
  "null-version",
  "wrong-key",
  "wrong-size",
  "wrong-kms",
  "bucket-key",
  "wrong-digest",
  "expiry",
])(
  "refuses %s content evidence without returning capability",
  async (failure) => {
    const normal = mockS3.getMockImplementation();
    mockS3.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (failure === "null-version") result.VersionId = "null";
      if (failure === "wrong-size") result.ContentLength++;
      if (failure === "wrong-kms") result.SSEKMSKeyId += "other";
      if (failure === "bucket-key") result.BucketKeyEnabled = true;
      if (failure === "wrong-digest" && result.Body)
        result.Body = Readable.from([Buffer.alloc(result.ContentLength, 0)]);
      if (failure === "expiry")
        Date.now.mockReturnValue(
          mockFixture.binding.manifest.validUntil * 1000,
        );
      return result;
    });
    if (failure === "wrong-key")
      mockFixture.fixtures[0].history.checkpoint.manifest.key =
        "customer/context";
    await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow();
  },
);

test("all manifest references are checked before any audio, including duplicate identities", async () => {
  rewriteManifest((manifest) => {
    manifest.artifacts.push(manifest.artifacts[0]);
  });
  await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow();
  expect(
    mockS3.mock.calls.every(([command]) =>
      command.input.Key.includes("/manifests/"),
    ),
  ).toBe(true);
});

test("public collector failure never exposes raw provider or generated evidence", async () => {
  mockLoad.mockRejectedValue(new Error("SENSITIVE_PROVIDER_SENTINEL"));
  await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow(
    /^fixture_content_refused$/,
  );
});

function rewriteManifest(change) {
  const fixture = mockFixture.fixtures[0];
  const original = mockFixture.objects.get(
    fixture.history.checkpoint.manifest.key,
  );
  const manifest = JSON.parse(original.bytes.toString("utf8"));
  change(manifest, fixture);
  const bytes = Buffer.from(JSON.stringify(manifest));
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const reference = {
    key: original.reference.key.replace(
      original.reference.checksumSha256,
      checksumSha256,
    ),
    checksumSha256,
    byteLength: bytes.length,
  };
  mockFixture.objects.set(reference.key, {
    bytes,
    reference,
    versionId: "changed-manifest",
  });
  fixture.history.checkpoint.manifest = reference;
  fixture.review.manifest = { ...reference, versionId: "changed-manifest" };
}

test.each(["bad-pcm", "overlap-short", "forged-span"])(
  "actual reader refuses %s before returning content authority",
  async (failure) => {
    rewriteManifest((manifest, fixture) => {
      const audio = manifest.artifacts[0];
      if (failure === "bad-pcm") audio.format.channels = 2;
      if (failure === "overlap-short")
        audio.coverage.intervals = [
          { sourceId: audio.sourceId, startOffsetMs: 0, durationMs: 100000 },
          { sourceId: audio.sourceId, startOffsetMs: 0, durationMs: 100000 },
        ];
      if (failure === "forged-span") {
        const end = "1970-01-01T00:02:42.000Z";
        fixture.history.capture.endedAt = end;
        fixture.history.fixtureInput.captureEndedAt = end;
        fixture.history.fixtureInput.observationEndedAt = end;
        manifest.captureState = fixture.history.capture;
        manifest.fixtureInput = fixture.history.fixtureInput;
      }
    });
    await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow(
      /^fixture_content_refused$/,
    );
  },
);

test("both exact storage tuples are checked before any session or content read", async () => {
  const fixture = mockFixture.fixtures[1];
  fixture.history.fixtureTranscript.key = "other/generated/transcript.json";
  fixture.history.transcriptS3Key = fixture.history.fixtureTranscript.key;
  fixture.review.transcript.key = fixture.history.fixtureTranscript.key;
  await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow();
  expect(mockSts).not.toHaveBeenCalled();
  expect(mockS3).not.toHaveBeenCalled();
});

test("history reads use only exact authenticated consumed-grant keys and bounded projections", async () => {
  await collectGeneratedFixturesFromOriginalRun({
    historyKey: { guildId: "customer", channelId_timestamp: "other" },
  });
  const expected = mockFixture.fixtures.map((f) => f.grant.historyKey);
  expect(
    mockDdb.mock.calls.map(([command]) => unmarshall(command.input.Key)),
  ).toEqual([expected[0], expected[1], expected[0], expected[1]]);
  for (const [command] of mockDdb.mock.calls) {
    expect(command.constructor.name).toBe("GetItemCommand");
    expect(command.input.ConsistentRead).toBe(true);
    expect(command.input.ProjectionExpression).toBeTruthy();
    expect(
      Object.values(command.input.ExpressionAttributeNames).some((name) =>
        ["context", "chat", "prompt"].includes(name),
      ),
    ).toBe(false);
  }
});

test.each([
  "missing-session",
  "other-fixture",
  "wrong-caller",
  "past-original-expiry",
])(
  "actual content reader refuses %s narrowed-session evidence",
  async (reason) => {
    const normal = mockSts.getMockImplementation();
    mockSts.mockImplementation(async (command, settings) => {
      const result = await normal(command, settings);
      if (command.kind === "assume" && reason === "missing-session")
        delete result.Credentials;
      if (command.kind === "assume" && reason === "other-fixture")
        result.AssumedRoleUser.Arn = result.AssumedRoleUser.Arn.replace(
          /-0$/,
          "-1",
        );
      if (command.kind === "identity" && reason === "wrong-caller")
        result.Arn += "other";
      if (command.kind === "assume" && reason === "past-original-expiry")
        result.Credentials.Expiration = new Date(
          (mockFixture.binding.manifest.validUntil + 1) * 1000,
        ).toISOString();
      return result;
    });
    await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow();
    expect(mockS3).not.toHaveBeenCalled();
  },
);

test.each([
  "override",
  "non-uuid",
  "oversize",
  "fallback-name",
  "missing-fallback-source",
])("refuses %s before session issuance", async (reason) => {
  const fixture = mockFixture.fixtures[1];
  if (reason === "override") {
    const normal = mockAws.getMockImplementation();
    mockAws.mockImplementation(async (...args) => {
      const result = await normal(...args);
      result.tasks[0].overrides = [{ environmentNames: ["BOT_INSTANCE_ID"] }];
      return result;
    });
  }
  if (reason === "non-uuid")
    fixture.grant.ownership.ownerInstanceId = "unbounded-owner";
  if (reason === "oversize") {
    fixture.history.checkpoint.manifest.byteLength = 64 * 1024 * 1024 + 1;
    fixture.review.manifest.byteLength =
      fixture.history.checkpoint.manifest.byteLength;
  }
  if (reason === "fallback-name")
    fixture.history.fixtureGeneration.tuples[0].prompt = {
      kind: "resolved",
      name: "wrong-template",
      version: 0,
      fallback: true,
    };
  if (reason === "missing-fallback-source")
    mockFallback.mockImplementation(() => {
      throw Error("source_refused");
    });
  await expect(collectGeneratedFixturesFromOriginalRun()).rejects.toThrow();
  expect(mockSts).not.toHaveBeenCalled();
  expect(mockS3).not.toHaveBeenCalled();
});
test("local fallback tuple consumes its authenticated source template binding", async () => {
  mockFixture.fixtures[0].history.fixtureGeneration.tuples[0].prompt = {
    kind: "resolved",
    name: "chronote-transcription-prompt",
    version: 0,
    fallback: true,
  };
  const result = readGeneratedFixtures(
    await collectGeneratedFixturesFromOriginalRun(),
  );
  expect(result.fixtures[0].fallbackSource).toEqual([
    {
      sourceCommit: mockFixture.binding.manifest.identity.sourceCommit,
      path: "src/services/transcriptionPromptService.ts",
      sourceSha256: "c".repeat(64),
    },
  ]);
});
