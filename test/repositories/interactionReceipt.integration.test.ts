/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { tryCreateInteractionReceipt } from "../../src/db";
import {
  createScratchTable,
  describeLocalDynamo,
  localDynamoClient,
} from "./localDynamo.fixture";

let mockInstanceId = "synthetic-worker-a";
jest.mock("../../src/services/runtimeInstanceService", () => ({
  ...jest.requireActual("../../src/services/runtimeInstanceService"),
  getRuntimeInstanceId: () => mockInstanceId,
}));

/** A token is idempotent for ten minutes, so ids must not repeat across runs against one local Dynamo. */
const RUN = randomUUID();
const receipt = (interactionId: string) => ({
  interactionId: `${interactionId}-${RUN}`,
  interactionKind: "button:end_meeting",
  guildId: "synthetic-guild",
  createdAt: "2026-11-11T00:00:00.000Z",
  expiresAt: 1_900_000_000,
});

describeLocalDynamo("interaction receipts against local Dynamo", () => {
  const client = localDynamoClient();
  const realSend = DynamoDBClient.prototype.send;
  let table: Awaited<ReturnType<typeof createScratchTable>>;
  /** Sends each db.ts command to the scratch table, optionally twice to stand in for an SDK retry. */
  let resendAfterLostResponse = false;

  beforeAll(async () => {
    table = await createScratchTable(client, "interaction-receipt", {
      AttributeDefinitions: [
        { AttributeName: "interactionId", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "interactionId", KeyType: "HASH" }],
    });
    jest
      .spyOn(DynamoDBClient.prototype, "send")
      .mockImplementation(async function (command: {
        input: {
          TransactItems?: Array<{ Put?: { TableName?: string } }>;
          TableName?: string;
        };
      }) {
        for (const item of command.input.TransactItems ?? [])
          if (item.Put) item.Put.TableName = table.TableName;
        if (command.input.TableName) command.input.TableName = table.TableName;
        const send = () => Reflect.apply(realSend, client, [command]);
        if (!resendAfterLostResponse) return send();
        // The first write lands but its response is lost; the SDK retries the same request.
        await send();
        return send();
      } as never);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await table.dispose();
    client.destroy();
  });
  beforeEach(() => {
    resendAfterLostResponse = false;
    mockInstanceId = "synthetic-worker-a";
  });

  test("a retried receipt write after a lost response is still ours", async () => {
    resendAfterLostResponse = true;
    await expect(
      tryCreateInteractionReceipt(receipt("synthetic-lost-response")),
    ).resolves.toBe(true);
  });

  test("two workers claiming one interaction: one wins", async () => {
    const claims: Array<Promise<boolean>> = [];
    for (const worker of ["synthetic-worker-a", "synthetic-worker-b"]) {
      mockInstanceId = worker;
      claims.push(tryCreateInteractionReceipt(receipt("synthetic-contested")));
    }
    const outcomes = await Promise.all(claims);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  test("many concurrent claims of one interaction: exactly one true", async () => {
    const ROUNDS = 5;
    const WORKERS = 10;
    for (let round = 0; round < ROUNDS; round++) {
      const claims: Array<Promise<boolean>> = [];
      for (let worker = 0; worker < WORKERS; worker++) {
        mockInstanceId = `synthetic-worker-${worker}`;
        claims.push(
          tryCreateInteractionReceipt(receipt(`synthetic-crowded-${round}`)),
        );
      }
      const outcomes = await Promise.all(claims);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    }
  });
});
