/** @jest-environment node */
import { jest, test, expect, afterEach } from "@jest/globals";
import { bound } from "../fixtures/productionManifest.js";
import { createProductionAws } from "../../scripts/deployment/production-aws.cjs";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { meetingUpdateIndexMetadata } from "../fixtures/productionMeetingUpdateIndex.js";
const mockSettings = Object.freeze({});
jest.mock("../../scripts/deployment/production-launcher-settings.cjs", () => ({
  readPausedEffectivePolicyScope: (token) => {
    if (token !== mockSettings) throw Error("settings_refused");
    return {};
  },
}));
const mockClients = [],
  mockExec = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: class {
      constructor(config) {
        this.config = config;
        this.send = jest.fn(async () => ({}));
        mockClients.push(this);
      }
    },
  };
});
jest.mock("node:child_process", () =>
  jest
    .requireActual("../fixtures/productionProcessMock.js")
    .processModuleMock((...args) => mockExec(...args)),
);

afterEach(() => {
  jest.restoreAllMocks();
  mockClients.splice(0);
  mockS3Clients.splice(0);
  mockExec.mockReset();
});

test("history index uses an exact regional SDK metadata read and returns only its bounded projection", async () => {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const binding = bound(),
    provider = createProductionAws(binding);
  const metadata = meetingUpdateIndexMetadata(binding.manifest);
  const raw = structuredClone(metadata);
  raw.Table.ItemCount = 999;
  raw.Table.TableSizeBytes = 999;
  raw.Table.AttributeDefinitions.push({
    AttributeName: "unrelated",
    AttributeType: "S",
  });
  raw.Table.GlobalSecondaryIndexes.push({
    IndexName: "Unrelated",
    ItemCount: 5,
  });
  raw.Table.GlobalSecondaryIndexes[0].ProvisionedThroughput = {
    ReadCapacityUnits: 5,
  };
  mockClients[0].send.mockResolvedValue(raw);
  const input = { TableName: binding.manifest.resources.tables.meetingHistory };
  await expect(
    provider.aws("dynamodb", "describe-table", input),
  ).resolves.toEqual(metadata);
  expect(mockClients[0].config.region).toBe(binding.manifest.identity.region);
  expect(mockClients[0].send).toHaveBeenCalledTimes(1);
  const command = mockClients[0].send.mock.calls[0][0];
  expect(command).toBeInstanceOf(DescribeTableCommand);
  expect(command.input).toEqual(input);
  expect(mockClients[1].send).not.toHaveBeenCalled();
  expect(mockExec).not.toHaveBeenCalled();
});

test.each(["foreign", "control", "extra", "query", "missing"])(
  "history index adapter refuses %s selectors before transport",
  async (kind) => {
    jest.spyOn(Date, "now").mockReturnValue(150000);
    const binding = bound(),
      provider = createProductionAws(binding);
    const input = {
      TableName: binding.manifest.resources.tables.meetingHistory,
    };
    if (kind === "foreign") input.TableName = "other-history";
    if (kind === "control")
      input.TableName = binding.manifest.resources.tables.deploymentControl;
    if (kind === "extra") input.ProjectionExpression = "anything";
    if (kind === "missing") delete input.TableName;
    await expect(
      provider.aws(
        "dynamodb",
        "describe-table",
        input,
        kind === "query" ? "Table" : undefined,
      ),
    ).rejects.toThrow("metadata_read_refused");
    expect(mockClients[0].send).not.toHaveBeenCalled();
    expect(mockClients[1].send).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  },
);

test("missing metadata and transport denial never fall back to a row read", async () => {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const binding = bound(),
    provider = createProductionAws(binding);
  const input = { TableName: binding.manifest.resources.tables.meetingHistory };
  await expect(
    provider.aws("dynamodb", "describe-table", input),
  ).rejects.toThrow("meeting_update_index_prerequisite");
  mockClients[0].send.mockRejectedValue(new Error("synthetic denied"));
  await expect(
    provider.aws("dynamodb", "describe-table", input),
  ).rejects.toThrow("synthetic denied");
  expect(
    mockClients[0].send.mock.calls.every(
      ([command]) => command instanceof DescribeTableCommand,
    ),
  ).toBe(true);
  expect(mockClients[1].send).not.toHaveBeenCalled();
});
test("actual SDK/CLI adapter disables mutation retries and retains default read retry configuration", async () => {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  mockExec.mockResolvedValue({ stdout: "{}", stderr: "" });
  const binding = bound(),
    provider = createProductionAws(binding);
  expect(mockClients[0].config.maxAttempts).toBeUndefined();
  expect(mockClients[1].config.maxAttempts).toBe(1);
  mockClients[1].send.mockRejectedValue(new Error("unknown"));
  await expect(
    provider.write({
      TransactItems: [
        {
          Put: {
            TableName: binding.manifest.resources.tables.deploymentControl,
            Item: {},
          },
        },
      ],
    }),
  ).rejects.toThrow("unknown");
  expect(mockClients[1].send).toHaveBeenCalledTimes(1);
  for (const operation of ["updateService", "modifyListener", "stopTask"]) {
    await provider.invoke(operation, {}, { maxAttempts: 1 });
    expect(mockExec.mock.calls.at(-1)[2].env.AWS_MAX_ATTEMPTS).toBe("1");
  }
  await provider.aws("ecs", "describe-services", {});
  expect(mockExec.mock.calls.at(-1)[2].env).toBeUndefined();
});
test("provider refuses generic mutations, delete, idempotent replay token and foreign table before transport", async () => {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const provider = createProductionAws(bound());
  await expect(provider.aws("ecs", "update-service", {})).rejects.toThrow();
  await expect(
    provider.invoke("runTask", {}, { maxAttempts: 1 }),
  ).rejects.toThrow();
  await expect(
    provider.invoke("stopTask", {}, { maxAttempts: 2 }),
  ).rejects.toThrow();
  for (const input of [
    { TransactItems: [{ Delete: { TableName: "test-control" } }] },
    { TransactItems: [{ Put: { TableName: "foreign" } }] },
    {
      ClientRequestToken: "retry",
      TransactItems: [{ Put: { TableName: "test-control" } }],
    },
  ])
    await expect(provider.write(input)).rejects.toThrow();
  expect(mockClients[1].send).not.toHaveBeenCalled();
  expect(mockExec).not.toHaveBeenCalled();
});

const mockPausedScopes = new WeakMap(),
  mockS3Clients = [];
jest.mock("../../scripts/deployment/production-paused-drafts.cjs", () => ({
  readPausedReaderScope: (token) => {
    const scope = mockPausedScopes.get(token);
    if (!scope) throw Error("paused_cohort_token_refused");
    return scope;
  },
}));
jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: class {
      constructor(config) {
        this.config = config;
        this.send = jest.fn(async () => ({}));
        mockS3Clients.push(this);
      }
    },
  };
});
function pausedProvider() {
  jest.spyOn(Date, "now").mockReturnValue(150000);
  const binding = bound(),
    token = Object.freeze({});
  mockPausedScopes.set(token, {
    manifest: binding.manifest,
    identities: [
      { uploadId: "u1", ownerUserId: "o1", sourceCount: 2 },
      { uploadId: "u2", ownerUserId: "o2", sourceCount: 1 },
    ],
    objects: [{ key: "recordings/u1/segment.wav", versionId: "immutable-v1" }],
  });
  return { provider: createProductionAws(binding), token, binding };
}

test("paused lifecycle absence is empty and access failures remain failures", async () => {
  const { provider, token } = pausedProvider();
  const send = mockS3Clients.at(-1).send;
  send.mockRejectedValueOnce(
    Object.assign(new Error("absent"), {
      name: "NoSuchLifecycleConfiguration",
    }),
  );
  await expect(
    provider.pausedDraftMetadata(token, mockSettings, {
      kind: "bucketLifecycle",
    }),
  ).resolves.toEqual({ Rules: [] });
  const denied = Object.assign(new Error("denied"), { name: "AccessDenied" });
  send.mockRejectedValueOnce(denied);
  await expect(
    provider.pausedDraftMetadata(token, mockSettings, {
      kind: "bucketLifecycle",
    }),
  ).rejects.toBe(denied);
});
test("paused parent uses exact consistent indexed projection without private text", async () => {
  const { provider, token, binding } = pausedProvider();
  await provider.pausedDraftMetadata(token, mockSettings, {
    kind: "parent",
    uploadId: "u1",
  });
  const input = mockClients[0].send.mock.calls[0][0].input;
  expect(input.TableName).toBe(binding.manifest.resources.tables.personalJob);
  expect(input.ConsistentRead).toBe(true);
  expect(input.KeyConditionExpression).toBe("#uploadId = :uploadId");
  expect(input.FilterExpression).toBe(
    "attribute_type(#manifest, :listType) AND size(#manifest) = :sourceCount",
  );
  expect(input.ExpressionAttributeValues).toMatchObject({
    ":uploadId": { S: "u1" },
    ":sourceCount": { N: "2" },
    ":listType": { S: "L" },
  });
  expect(Object.values(input.ExpressionAttributeNames)).not.toEqual(
    expect.arrayContaining([
      "label",
      "originalFileName",
      "title",
      "tags",
      "error",
    ]),
  );
  expect(input.ProjectionExpression).toContain("#manifest[0].#sourceId");
  expect(input.ProjectionExpression).toContain("#manifest[1].#kind");
  expect(input.ProjectionExpression.split(",")).not.toContain("#manifest");
});
test("paused segments and exact version HEAD return only structural metadata", async () => {
  const { provider, token } = pausedProvider();
  const cursor = { uploadId: { S: "u1" }, segmentKey: { S: "s1" } };
  await provider.pausedDraftMetadata(token, mockSettings, {
    kind: "segments",
    uploadId: "u1",
    cursor,
  });
  const input = mockClients[0].send.mock.calls[0][0].input;
  expect(input.ConsistentRead).toBe(true);
  expect(input.ExclusiveStartKey).toEqual(cursor);
  expect(Object.values(input.ExpressionAttributeNames)).not.toContain("label");
  mockS3Clients.at(-1).send.mockResolvedValue({
    VersionId: "immutable-v1",
    ContentLength: 4,
    ContentType: "audio/wav",
    ChecksumSHA256: "hash",
    ChecksumType: "FULL_OBJECT",
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: "synthetic-kms-key",
    Metadata: { secret: "omitted" },
  });
  await expect(
    provider.pausedDraftMetadata(token, mockSettings, {
      kind: "object",
      key: "recordings/u1/segment.wav",
      versionId: "immutable-v1",
    }),
  ).resolves.toEqual({
    VersionId: "immutable-v1",
    ContentLength: 4,
    ContentType: "audio/wav",
    ChecksumSHA256: "hash",
    ChecksumType: "FULL_OBJECT",
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: "synthetic-kms-key",
  });
  expect(mockS3Clients.at(-1).send.mock.calls[0][0].input).toEqual({
    Bucket: "test-artifacts",
    ExpectedBucketOwner: "123456789012",
    Key: "recordings/u1/segment.wav",
    VersionId: "immutable-v1",
    ChecksumMode: "ENABLED",
  });
});
test.each([
  { kind: "parent", uploadId: "foreign" },
  { kind: "parent", uploadId: "u1", sourceCount: 1 },
  { kind: "parent", uploadId: "u1", ProjectionExpression: "title" },
  { kind: "object", key: "recordings/u1/segment.wav" },
  { kind: "object", key: "recordings/u1/segment.wav", versionId: "null" },
  { kind: "object", key: "recordings/u1/segment.wav", versionId: "other" },
  { kind: "tableTtl", table: "meetingHistory" },
  {
    kind: "segments",
    uploadId: "u1",
    cursor: { uploadId: { S: "foreign" }, segmentKey: { S: "s1" } },
  },
])(
  "paused reader refuses unauthorized selectors before transport: %j",
  async (request) => {
    const { provider, token } = pausedProvider();
    await expect(
      provider.pausedDraftMetadata(token, mockSettings, request),
    ).rejects.toThrow();
    expect(mockClients[0].send).not.toHaveBeenCalled();
    expect(mockS3Clients.at(-1).send).not.toHaveBeenCalled();
  },
);
test("paused reader refuses copied tokens and scopes from another package", async () => {
  const { provider, token } = pausedProvider();
  await expect(
    provider.pausedDraftMetadata({ ...token }, mockSettings, {
      kind: "parent",
      uploadId: "u1",
    }),
  ).rejects.toThrow();
  const foreign = Object.freeze({}),
    scope = mockPausedScopes.get(token);
  mockPausedScopes.set(foreign, {
    ...scope,
    manifest: { ...scope.manifest, operationId: "other" },
  });
  await expect(
    provider.pausedDraftMetadata(foreign, mockSettings, {
      kind: "parent",
      uploadId: "u1",
    }),
  ).rejects.toThrow();
  expect(mockClients[0].send).not.toHaveBeenCalled();
});
test("paused storage metadata reads use only the bound tables and bucket", async () => {
  const { provider, token, binding } = pausedProvider();
  mockClients[0].send.mockResolvedValue({
    TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" },
    unrelated: "omitted",
  });
  await expect(
    provider.pausedDraftMetadata(token, mockSettings, {
      kind: "tableTtl",
      table: "personalJob",
    }),
  ).resolves.toEqual({
    TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" },
  });
  expect(mockClients[0].send.mock.calls[0][0].input).toEqual({
    TableName: binding.manifest.resources.tables.personalJob,
  });
  mockS3Clients.at(-1).send.mockResolvedValue({
    Status: "Enabled",
    Rules: [
      {
        ID: "abort",
        Status: "Enabled",
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
    ],
    unrelated: "omitted",
  });
  await expect(
    provider.pausedDraftMetadata(token, mockSettings, {
      kind: "bucketVersioning",
    }),
  ).resolves.toEqual({ Status: "Enabled" });
  await expect(
    provider.pausedDraftMetadata(token, mockSettings, {
      kind: "bucketLifecycle",
    }),
  ).resolves.toEqual({
    Rules: [
      {
        ID: "abort",
        Status: "Enabled",
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
    ],
  });
  for (const [command] of mockS3Clients.at(-1).send.mock.calls)
    expect(command.input).toEqual({
      Bucket: binding.manifest.resources.bucket,
      ExpectedBucketOwner: binding.manifest.identity.accountId,
    });
});

test("paused native read requires settings before transport and revalidates after transport", async () => {
  const { provider, token } = pausedProvider();
  await expect(
    provider.pausedDraftMetadata(token, {}, { kind: "parent", uploadId: "u1" }),
  ).rejects.toThrow();
  expect(mockClients[0].send).not.toHaveBeenCalled();
  mockClients[0].send.mockImplementation(async () => {
    mockPausedScopes.delete(token);
    return { Items: [] };
  });
  await expect(
    provider.pausedDraftMetadata(token, mockSettings, {
      kind: "parent",
      uploadId: "u1",
    }),
  ).rejects.toThrow();
});
