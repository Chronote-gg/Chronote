/** @jest-environment node */
import { randomUUID } from "node:crypto";
import {
  DeleteTableCommand,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  type GetItemCommandInput,
  type QueryCommandInput,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { localControlTable } from "./fixtures/localControlTable";
import { recoverRetainedSandbox } from "../../scripts/deployment/recover-retained-sandbox.cjs";
import { retainedSourceLossFixture } from "./fixtures/retainedSourceLossFixture";
import { sourceLossFixture } from "./fixtures/sourceLossFixture";
import { recoverSandbox } from "../../scripts/deployment/recover-sandbox.cjs";
const { client, createTable } = localControlTable();
afterAll(() => client.destroy());
test.each([
  "known",
  "lost_ack",
  "control_race",
  "proof_race",
  "retained_known",
  "retained_lost_ack",
  "retained_control_race",
  "retained_proof_race",
])(
  "native atomic admission/receipt and preserved voice guard: %s",
  async (scenario) => {
    const retained = scenario.startsWith("retained_");
    const f = await (retained
      ? retainedSourceLossFixture()
      : sourceLossFixture());
    if (retained) f.loss.missing = true;
    const recover = retained ? recoverRetainedSandbox : recoverSandbox;
    const table = `source-loss-${randomUUID()}-DeploymentControlTable`;
    const put = (row: object) =>
      client.send(
        new PutItemCommand({ TableName: table, Item: marshall(row) }),
      );
    const read = async (pk: string, sk: string) => {
      const result = await client.send(
        new GetItemCommand({
          TableName: table,
          Key: marshall({ pk, sk }),
          ConsistentRead: true,
        }),
      );
      return result.Item ? unmarshall(result.Item) : undefined;
    };
    await createTable(table);
    try {
      await put(f.state.ctl);
      await put(f.state.rows.old);
      await put(f.state.rows.new);
      const voice = {
        pk: "VOICE#guild",
        sk: "STATE",
        ownerInstanceId: "old",
        state: "uncertain",
        meetingId: "preserve",
        executionVersion: 3,
      };
      await put(voice);
      const original = f.aws.getMockImplementation()!;
      let changes = 0;
      async function transact(request: TransactWriteItemsCommandInput) {
        for (const item of request.TransactItems!) {
          if (item.Update) item.Update.TableName = table;
          if (item.Put) item.Put.TableName = table;
          if (item.ConditionCheck) item.ConditionCheck.TableName = table;
        }
        if (scenario.endsWith("control_race") && changes === 0)
          await client.send(
            new UpdateItemCommand({
              TableName: table,
              Key: marshall({ pk: "ENV", sk: "CONTROL" }),
              UpdateExpression: "SET coordinatorEpoch = :foreign",
              ExpressionAttributeValues: marshall({ ":foreign": 99 }),
            }),
          );
        if (scenario.endsWith("proof_race") && changes === 1)
          await client.send(
            new UpdateItemCommand({
              TableName: table,
              Key: marshall({ pk: "ENV", sk: "RUNTIME#new" }),
              UpdateExpression: "SET readiness.dependenciesReady = :unsafe",
              ExpressionAttributeValues: marshall({ ":unsafe": false }),
            }),
          );
        const response = await client.send(
          new TransactWriteItemsCommand(request),
        );
        changes++;
        if (scenario.endsWith("lost_ack"))
          throw new Error("lost after native commit");
        return response;
      }
      f.aws.mockImplementation(
        async (service: string, operation: string, input: unknown) => {
          if (service !== "dynamodb" || operation === "scan")
            return original(service, operation, input);
          if (operation === "get-item")
            return client.send(
              new GetItemCommand({
                ...(input as GetItemCommandInput),
                TableName: table,
              }),
            );
          if (operation === "query")
            return client.send(
              new QueryCommand({
                ...(input as QueryCommandInput),
                TableName: table,
              }),
            );
          if (operation === "transact-write-items")
            return transact(input as TransactWriteItemsCommandInput);
          throw new Error("Unexpected source-loss write");
        },
      );
      const options = {
        ...f.options,
        mode: "inspect",
        sleep: async () => {
          f.loss.clock++;
          await client.send(
            new UpdateItemCommand({
              TableName: table,
              Key: marshall({ pk: "ENV", sk: "RUNTIME#new" }),
              UpdateExpression:
                "SET heartbeatAt = :now, readiness.provenAt = :now, readiness.expiresAt = :expiry",
              ExpressionAttributeValues: marshall({
                ":now": f.loss.clock,
                ":expiry": f.loss.clock + 30,
              }),
            }),
          );
        },
      };
      const inspection = await recover(options);
      const recovering = recover({
        ...options,
        env: {
          ...options.env,
          SOURCE_LOSS_BINDING_SHA256: inspection.bindingSha256,
        },
        mode: "recover",
      });
      if (scenario.endsWith("race")) {
        await expect(recovering).rejects.toThrow();
        expect(changes).toBe(scenario.endsWith("control_race") ? 0 : 1);
        expect(await read("VOICE#guild", "STATE")).toEqual(voice);
        expect(await read("ENV", "RUNTIME#old")).toEqual(f.state.rows.old);
        expect(
          f.calls.filter((call) => call.operation === "modify-listener"),
        ).toHaveLength(0);
        return;
      }
      expect(await recovering).toMatchObject({
        kind: "availability_restored",
        settlement: "lost_owner_settlement_pending",
      });
      expect((await read("ENV", "CONTROL"))?.deployment.phase).toBe("promoted");
      expect((await read("SOURCELOSS#run-2", "RECOVERY"))?.stage).toBe(
        "availability_restored",
      );
      expect(await read("VOICE#guild", "STATE")).toEqual(voice);
      expect(await read("ENV", "RUNTIME#old")).toEqual(f.state.rows.old);
      expect(changes).toBe(3);
    } finally {
      await client.send(new DeleteTableCommand({ TableName: table }));
    }
  },
);
