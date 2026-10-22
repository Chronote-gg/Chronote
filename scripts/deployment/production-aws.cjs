"use strict";
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
function createReaders(m) {
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
      if (input.TableName !== table) throw new Error("metadata_read_refused");
      if (operation === "get-item")
        return readClient.send(new GetItemCommand(input));
      if (operation === "query")
        return readClient.send(new QueryCommand(input));
      throw new Error("production_write_refused");
    }
    if (
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
  return { read, scan, aws };
}
function createAcceptanceReadAws(collection) {
  const { manifest } =
    require("./production-private-package.cjs").readCollectionBinding(
      collection,
    );
  const { read, aws } = createReaders(manifest);
  const readers = { read, aws };
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
  const readers = createReaders(m),
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
          ![table, m.resources.tables.meetingControl].includes(
            (item.Put ?? item.Update ?? item.ConditionCheck)?.TableName,
          ),
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
