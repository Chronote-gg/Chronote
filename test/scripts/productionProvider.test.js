/** @jest-environment node */
import { jest, test, expect, afterEach } from "@jest/globals";
import { bound } from "../fixtures/productionManifest.js";
import { createProductionAws } from "../../scripts/deployment/production-aws.cjs";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { meetingUpdateIndexMetadata } from "../fixtures/productionMeetingUpdateIndex.js";
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
jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process"),
    execFile = () => undefined;
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) =>
    mockExec(...args);
  return { ...actual, execFile };
});
afterEach(() => {
  jest.restoreAllMocks();
  mockClients.splice(0);
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
