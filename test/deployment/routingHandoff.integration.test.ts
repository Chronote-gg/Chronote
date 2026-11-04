/** @jest-environment node */
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  GetItemCommandInput,
  UpdateItemCommandInput,
  QueryCommandInput,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { routingFixture } from "./fixtures/routingFixture";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import { startRuntimeHealthServer } from "../../src/services/runtimeHealthServer";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import { createDynamoArtifactSafetyRepository } from "../../src/repositories/artifactSafetyRepository";
import { createDynamoDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { createRuntimeArtifactSafety } from "../../src/services/runtimeArtifactSafety";
import { createArtifactAdmissionGate } from "../../src/services/artifactAdmissionGate";

const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
afterAll(() => client.destroy());
test("real requests stay on the old application while its producers are sealed, then move only after candidate boot", async () => {
  const f = routingFixture();
  const prefix = `routing-${randomUUID()}-`;
  const table = `${prefix}DeploymentControlTable`;
  const tables = {
    deploymentControl: table,
    meetingHistory: prefix + "MeetingHistoryTable",
  };
  const targetArtifacts = f.state.artifacts.get("new");
  if (targetArtifacts?.startup.kind !== "sealed")
    throw new Error("Candidate fixture missing");
  const snapshot = targetArtifacts.startup.proof.snapshot;
  const admission = createArtifactAdmissionGate();
  const artifactSafety = createRuntimeArtifactSafety({
    identity: f.state.rows.old.identity,
    repository: createDynamoArtifactSafetyRepository(client, tables),
    control: createDynamoDeploymentControlRepository(client, tables),
    admission,
    now: f.options.now,
    isProtected: () => true,
    storage: {
      seal: async () => snapshot,
      recheck: async () => snapshot,
      resume: () => undefined,
    },
  });
  const old = await startRuntimeHealthServer(0);
  const candidate = await startRuntimeHealthServer(0);
  const origin = (
    server: Awaited<ReturnType<typeof startRuntimeHealthServer>>,
  ) => `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  const put = (row: object) =>
    client.send(
      new PutItemCommand({
        TableName: table,
        Item: marshall(row, { removeUndefinedValues: true }),
      }),
    );
  const read = async () =>
    unmarshall(
      (
        await client.send(
          new GetItemCommand({
            TableName: table,
            Key: marshall({ pk: "ENV", sk: "CONTROL" }),
            ConsistentRead: true,
          }),
        )
      ).Item!,
    );
  const handler =
    (label: string): RequestListener =>
    (_request, response) => {
      response.writeHead(200);
      response.end(label);
    };
  old.activate(handler("old available application"));
  const request = async () => {
    const selected = f.traffic.actions[0].ForwardConfig.TargetGroups.find(
      (group) => group.Weight === 100,
    )!.TargetGroupArn;
    return fetch(
      `${origin(selected === "group-a" ? old : candidate)}/auth/discord`,
    );
  };
  const syncProofs = async () => {
    f.state.ctl = (await read()) as typeof f.state.ctl;
    f.refreshProofs();
    await put(f.state.artifacts.get("new")!);
    for (const row of Object.values(f.state.rows)) {
      const updated = await client.send(
        new UpdateItemCommand({
          TableName: table,
          Key: marshall({ pk: "ENV", sk: row.sk }),
          UpdateExpression:
            "SET readiness = :readiness, protection = :protection",
          ExpressionAttributeValues: marshall({
            ":readiness": row.readiness,
            ":protection": row.protection,
          }),
          ReturnValues: "ALL_NEW",
        }),
      );
      f.state.rows[row.identity.instanceId] = unmarshall(
        updated.Attributes!,
      ) as typeof row;
    }
  };
  let protection;
  try {
    await client.send(
      new CreateTableCommand({
        TableName: table,
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
    await put(f.state.ctl);
    await put(f.state.rows.old);
    await put(f.state.rows.new);
    for (const artifact of f.state.artifacts.values()) await put(artifact);
    f.definition.containerDefinitions[0].environment[0].value = prefix;
    const original = f.aws.getMockImplementation()!;
    f.aws.mockImplementation(async (service, operation, input) => {
      if (service !== "dynamodb") return original(service, operation, input);
      switch (operation) {
        case "get-item": {
          const command = new GetItemCommand(input as GetItemCommandInput);
          let result = await client.send(command);
          if (
            result.Item?.sk.S === "ARTIFACTS#old/STATE" &&
            result.Item.state.S === "requested"
          ) {
            await artifactSafety.refresh();
            for (let poll = 0; poll < 30; poll++) {
              result = await client.send(command);
              if (result.Item?.state.S === "sealed") break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return result;
        }
        case "update-item":
          return client.send(
            new UpdateItemCommand(input as UpdateItemCommandInput),
          );
        case "query":
          return client.send(new QueryCommand(input as QueryCommandInput));
        case "transact-write-items":
          return client.send(
            new TransactWriteItemsCommand(
              input as TransactWriteItemsCommandInput,
            ),
          );
        default:
          throw new Error("Unexpected Dynamo operation");
      }
    });
    const coordinator = createCoordinator({
      ...f.options,
      env: { ...f.options.env, SECRETS_PREFIX: prefix.slice(0, -1) },
    });
    await coordinator.prepare();
    expect(() => admission.begin()).toThrow("sealed");
    await syncProofs();
    expect((await fetch(`${origin(candidate)}/health`)).status).toBe(200);
    expect((await fetch(`${origin(candidate)}/auth/discord`)).status).toBe(503);
    expect(await (await request()).text()).toBe("old available application");
    let confirmed = false;
    protection = createRuntimeProtectionService({
      identity: f.candidateIdentity,
      agentUri: "http://fixture",
      onUnsafe: jest.fn(),
      initialRetry: async () => {
        expect((await fetch(`${origin(candidate)}/health`)).status).toBe(200);
        expect(await (await request()).text()).toBe(
          "old available application",
        );
        confirmed = true;
      },
      request: async () =>
        confirmed
          ? Response.json({
              protection: {
                TaskArn: f.candidateIdentity.taskArn,
                ProtectionEnabled: true,
                ExpirationDate: new Date(Date.now() + 600000).toISOString(),
              },
            })
          : Response.json({
              failure: {
                Arn: f.candidateIdentity.taskArn,
                Reason: "DEPLOYMENT_BLOCKED",
              },
            }),
    });
    await protection.start();
    expect(protection.isSafe()).toBe(true);
    // Protection exists but boot still has no application handler or readiness proof.
    f.state.rows.new.readiness.dependenciesReady = false;
    await syncProofs();
    await expect(coordinator.promote()).rejects.toThrow("readiness timeout");
    expect((await read()).servingMembers.old).toBeDefined();
    expect(await (await request()).text()).toBe("old available application");
    candidate.activate(handler("candidate available application"));
    f.state.rows.new.readiness.dependenciesReady = true;
    await syncProofs();
    // The fixture clock advanced during failed warmup. The provider and persisted proofs are refreshed together.
    await coordinator.promote();
    expect((await read()).deployment.routing.state).toBe("candidate");
    expect(await (await request()).text()).toBe(
      "candidate available application",
    );
    expect(f.state.rows.old.workCounts!.recording).toBe(0);
    expect(f.state.rows.old.retirementRequest).toBeUndefined();
    expect((await fetch(`${origin(old)}/auth/discord`)).status).toBe(200);
    await syncProofs();
    expect(f.state.rows.new).toMatchObject({
      role: "serving",
      authorizedGeneration: 2,
    });
    expect(await coordinator.reconcile()).toMatchObject({
      kind: "rolled_back",
      candidatePreserved: true,
    });
    expect(await (await request()).text()).toBe("old available application");
    await syncProofs();
    await artifactSafety.refresh();
    await artifactSafety.refresh();
    expect(admission.sealed).toBe(false);
  } finally {
    artifactSafety.stop();
    protection?.stop();
    await old.close();
    await candidate.close();
    await client.send(new DeleteTableCommand({ TableName: table }));
  }
});
