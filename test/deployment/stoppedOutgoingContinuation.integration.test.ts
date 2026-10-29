import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { buildStoppedOutgoingContinuation } from "../../src/services/deploymentControlTransactions";
import type {
  ControlRecord,
  RuntimeRecord,
} from "../../src/types/deploymentControl";
import { control, runtime } from "./controlFixtures";

const prefix = `deployment-test-${randomUUID()}-`;
const tables = {
  deploymentControl: `${prefix}DeploymentControlTable`,
  meetingHistory: `${prefix}MeetingHistoryTable`,
};
const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});

beforeAll(async () => {
  await client.send(
    new CreateTableCommand({
      TableName: tables.deploymentControl,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
    }),
  );
});
afterAll(async () => {
  await client.send(
    new DeleteTableCommand({ TableName: tables.deploymentControl }),
  );
  client.destroy();
});

test("stopped outgoing continuation is one CAS that loses to a live heartbeat or a new coordinator", async () => {
  const outgoing = runtime("old");
  const candidate = runtime("new");
  const retiring: ControlRecord = {
    ...control,
    servingGeneration: 8,
    servingMembers: { new: candidate.identity },
    deployment: {
      runToken: "coordinator",
      cluster: "cluster",
      service: "service",
      family: "family",
      tablePrefix: prefix,
      candidateId: "new",
      image: "repo@sha256:fixture",
      runtimeMode: "all",
      phase: "retiring",
      originalGeneration: 7,
      originalMembers: [outgoing.identity],
      outgoing: outgoing.identity,
      previousTaskDefinition: "definition:old",
      taskDefinition: "definition:new",
      candidate: candidate.identity,
      updatedAt: 100,
    },
  };
  const lostCounts = {
    pending_admission: 0,
    recording: 0,
    finalization: 1,
    personal_processing: 0,
    recovery_processing: 0,
    voice_operation: 0,
    ancillary_delivery: 0,
  };
  const draining: RuntimeRecord = {
    ...outgoing,
    role: "draining",
    workCounts: lostCounts,
    retirementRequest: {
      identity: outgoing.identity,
      authorizedGeneration: 7,
      coordinatorToken: "coordinator",
      coordinatorEpoch: 3,
    },
  };
  for (const item of [retiring, draining])
    await client.send(
      new PutItemCommand({
        TableName: tables.deploymentControl,
        Item: marshall(item),
      }),
    );
  const continuation = {
    reason: "outgoing_task_stopped" as const,
    taskStatus: "stopped" as const,
    stoppedAt: "2026-10-29T12:00:00.000Z",
    lostWorkCounts: lostCounts,
    continuedBy: "next-run",
    continuedAt: 300,
  };
  const write = (control: ControlRecord, row: RuntimeRecord) =>
    client.send(
      new TransactWriteItemsCommand(
        buildStoppedOutgoingContinuation(
          { control, outgoing: row, continuation, now: 300 },
          tables,
        ),
      ),
    );
  const read = async (sk: string) =>
    unmarshall(
      (
        await client.send(
          new GetItemCommand({
            TableName: tables.deploymentControl,
            Key: marshall({ pk: "ENV", sk }),
            ConsistentRead: true,
          }),
        )
      ).Item!,
    );
  await expect(
    write(retiring, { ...draining, heartbeatAt: 99 }),
  ).rejects.toThrow();
  await expect(
    write({ ...retiring, coordinatorEpoch: 2 }, draining),
  ).rejects.toThrow();
  expect((await read("CONTROL")).deployment.phase).toBe("retiring");
  await write(retiring, draining);
  expect((await read("CONTROL")).deployment).toEqual({
    ...retiring.deployment,
    phase: "complete",
    updatedAt: 300,
  });
  expect(await read(draining.sk)).toEqual({
    ...draining,
    role: "retired",
    retirementContinuation: continuation,
  });
  await expect(write(retiring, draining)).rejects.toThrow();
});
