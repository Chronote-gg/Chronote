"use strict";
const { isDeepStrictEqual } = require("node:util");
const {
  S3Client,
  HeadObjectCommand,
  GetBucketVersioningCommand,
  GetBucketLifecycleConfigurationCommand,
} = require("@aws-sdk/client-s3");
const { DescribeTimeToLiveCommand } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
} = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { awsCli } = require("./coordinator-aws.cjs");
const { assertBoundExecution } = require("./production-manifest.cjs");
function createReaders(m, introduction = false) {
  const readClient = new DynamoDBClient({ region: m.identity.region });
  const table = m.resources.tables.deploymentControl;
  const read = async (key) => {
    const r = await readClient.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall(key),
        ConsistentRead: true,
      }),
    );
    return r.Item ? unmarshall(r.Item) : undefined;
  };
  const scan = async (operation, input) => {
    if (
      operation !== "scan" ||
      !Object.values(m.resources.tables).includes(input.TableName) ||
      !input.ProjectionExpression ||
      input.ConsistentRead !== true
    )
      throw new Error("metadata_read_refused");
    return readClient.send(new ScanCommand(input));
  };
  const aws = async (service, operation, input, query) => {
    if (service === "dynamodb") {
      if (operation === "describe-table") {
        if (!introduction) throw new Error("metadata_read_refused");
        return require("./production-index-preflight.cjs").readMeetingUpdateIndex(
          readClient,
          m,
          input,
          query,
        );
      }
      if (input.TableName !== table) throw new Error("metadata_read_refused");
      if (operation === "get-item")
        return readClient.send(new GetItemCommand(input));
      if (operation === "query")
        return readClient.send(new QueryCommand(input));
      throw new Error("production_write_refused");
    }
    if (
      !(
        service === "iam" &&
        [
          "get-role",
          "list-role-policies",
          "get-role-policy",
          "list-attached-role-policies",
          "get-policy",
          "get-policy-version",
          "get-open-id-connect-provider",
        ].includes(operation)
      ) &&
      !/^(describe-|list-|get-task-protection$|get-caller-identity$|validate-update-service$)/.test(
        operation,
      )
    )
      throw new Error("production_write_refused");
    return require("./production-projections.cjs").cleanProjection(
      await awsCli(service, operation, input, {
        region: m.identity.region,
        query:
          query ??
          require("./production-projections.cjs").projection(
            service,
            operation,
          ),
      }),
    );
  };
  return {
    read,
    scan,
    aws,
    pausedDraftMetadata: pausedMetadataReader(m, readClient),
  };
}
function createAcceptanceReadAws(collection) {
  const { manifest } =
    require("./production-private-package.cjs").readCollectionBinding(
      collection,
    );
  const { read, scan, aws, pausedDraftMetadata } = createReaders(manifest);
  const readers = { read, scan, aws, pausedDraftMetadata };
  return Object.fromEntries(
    Object.entries(readers).map(([name, read]) => [
      name,
      async (...args) => {
        require("./production-private-package.cjs").readCollectionBinding(
          collection,
        );
        const result = await read(...args);
        require("./production-private-package.cjs").readCollectionBinding(
          collection,
        );
        return result;
      },
    ]),
  );
}
function createProductionAws(binding) {
  const m = assertBoundExecution(binding, Math.floor(Date.now() / 1000));
  const readers = createReaders(m, true),
    table = m.resources.tables.deploymentControl;
  const writeClient = new DynamoDBClient({
    region: m.identity.region,
    maxAttempts: 1,
  });
  const write = async (input) => {
    // Dispatch checks expiry; journal persistence must retain a direct ACK after expiry.
    if (
      input.ClientRequestToken ||
      !input.TransactItems?.length ||
      input.TransactItems.some(
        (item) =>
          item.Delete ||
          !(item.ConditionCheck
            ? Object.values(m.resources.tables).includes(
                item.ConditionCheck.TableName,
              )
            : [table, m.resources.tables.meetingControl].includes(
                (item.Put ?? item.Update)?.TableName,
              )),
      )
    )
      throw new Error("production_write_refused");
    return writeClient.send(new TransactWriteItemsCommand(input));
  };
  const invoke = async (operation, input, settings) => {
    if (settings.maxAttempts !== 1) throw new Error("production_write_refused");
    if (operation === "transactWriteItems") return write(input);
    const routes = {
      stopTask: ["ecs", "stop-task"],
      updateService: ["ecs", "update-service"],
      modifyListener: ["elbv2", "modify-listener"],
    };
    const route = routes[operation];
    if (!route) throw new Error("production_write_refused");
    return require("./production-projections.cjs").cleanProjection(
      await awsCli(...route, input, {
        region: m.identity.region,
        maxAttempts: 1,
        query: require("./production-projections.cjs").projection(...route),
      }),
    );
  };
  return { ...readers, write, invoke };
}
module.exports = { createProductionAws, createAcceptanceReadAws };

function pausedReadRefused() {
  throw Error("metadata_read_refused");
}
function assertPausedMetadataRequest(scope, manifest, request) {
  if (!isDeepStrictEqual(scope.manifest, manifest)) pausedReadRefused();
  const allowed = {
    parent: ["kind", "uploadId", "cursor"],
    segments: ["kind", "uploadId", "cursor"],
    object: ["kind", "key", "versionId"],
    tableTtl: ["kind", "table"],
    bucketVersioning: ["kind"],
    bucketLifecycle: ["kind"],
  };
  if (
    !allowed[request.kind] ||
    Object.keys(request).some((key) => !allowed[request.kind].includes(key))
  )
    pausedReadRefused();
}
async function readPausedObjectMetadata(s3, manifest, scope, request) {
  if (
    !request.versionId ||
    request.versionId === "null" ||
    !scope.objects.some(
      (o) => o.key === request.key && o.versionId === request.versionId,
    )
  )
    pausedReadRefused();
  const response = await s3.send(
    new HeadObjectCommand({
      Bucket: manifest.resources.bucket,
      ExpectedBucketOwner: manifest.identity.accountId,
      Key: request.key,
      VersionId: request.versionId,
      ChecksumMode: "ENABLED",
    }),
  );
  return Object.fromEntries(
    [
      "VersionId",
      "ContentLength",
      "ContentType",
      "ChecksumSHA256",
      "ChecksumSHA1",
      "ChecksumCRC32",
      "ChecksumCRC32C",
      "ChecksumCRC64NVME",
      "ChecksumType",
      "DeleteMarker",
      "ServerSideEncryption",
      "SSEKMSKeyId",
      "BucketKeyEnabled",
    ]
      .filter((key) => response[key] !== undefined)
      .map((key) => [key, response[key]]),
  );
}
function assertPausedCursor(cursor, identity, parent) {
  if (!cursor) return;
  const keys = parent ? ["uploadId"] : ["uploadId", "segmentKey"];
  if (
    Object.keys(cursor).length !== keys.length ||
    !keys.every(
      (key) =>
        Object.keys(cursor[key] ?? {}).length === 1 &&
        typeof cursor[key].S === "string",
    ) ||
    cursor.uploadId.S !== identity.uploadId
  )
    pausedReadRefused();
}
function pausedMetadataQuery(manifest, scope, request) {
  const identity = scope.identities.find(
    (row) => row.uploadId === request.uploadId,
  );
  if (
    !identity ||
    !Number.isInteger(identity.sourceCount) ||
    identity.sourceCount < 1 ||
    identity.sourceCount > 4
  )
    pausedReadRefused();
  const parent = request.kind === "parent";
  assertPausedCursor(request.cursor, identity, parent);
  return new QueryCommand(
    require("./production-paused-metadata.cjs").pausedQueryInput(
      require("./production-paused-contract.cjs").scopeFor(manifest),
      identity,
      request.kind,
      request.cursor,
    ),
  );
}

function pausedMetadataReader(manifest, client) {
  const s3 = new S3Client({ region: manifest.identity.region });
  const bucket = {
    Bucket: manifest.resources.bucket,
    ExpectedBucketOwner: manifest.identity.accountId,
  };
  async function dispatch(scope, request) {
    switch (request.kind) {
      case "object":
        return readPausedObjectMetadata(s3, manifest, scope, request);
      case "tableTtl": {
        if (!["personalJob", "personalSegment"].includes(request.table))
          pausedReadRefused();
        const response = await client.send(
          new DescribeTimeToLiveCommand({
            TableName: manifest.resources.tables[request.table],
          }),
        );
        return { TimeToLiveDescription: response.TimeToLiveDescription };
      }
      case "bucketVersioning": {
        const response = await s3.send(new GetBucketVersioningCommand(bucket));
        return { Status: response.Status, MFADelete: response.MFADelete };
      }
      case "bucketLifecycle": {
        try {
          const response = await s3.send(
            new GetBucketLifecycleConfigurationCommand(bucket),
          );
          return { Rules: response.Rules };
        } catch (error) {
          if (error.name !== "NoSuchLifecycleConfiguration") throw error;
          return { Rules: [] };
        }
      }
      default:
        return client.send(pausedMetadataQuery(manifest, scope, request));
    }
  }
  return async (token, settingsToken, request) => {
    const readScope = () => {
      const scope =
        require("./production-paused-drafts.cjs").readPausedReaderScope(token);
      require("./production-launcher-settings.cjs").readPausedEffectivePolicyScope(
        settingsToken,
        token,
        scope.purpose,
      );
      assertPausedMetadataRequest(scope, manifest, request);
      return scope;
    };
    const response = await dispatch(readScope(), request);
    readScope();
    return response;
  };
}
