import { randomUUID } from "node:crypto";
import {
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  QueryCommand,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { runDynamoInitializationAgainst } from "../../scripts/dynamoInitScript.fixture";
import type { ActiveMeetingLease, MeetingHistory } from "../../../src/types/db";

const WORKERS_PK = "WORKERS";
const CUTOVER_SK = "CUTOVER";
const LEGACY_RUNTIME_PK = "ENV";

// Mirrors RegistryView from task A4's workerRegistryRepository, which lands
// in parallel; scenarios compare against it structurally.
export type RegistryWorker = {
  instanceId: string;
  release: number;
  ready: boolean;
  heartbeatAt: number;
  captures: number;
  finishing: number;
  protectedUntil?: number;
};
export type RegistryView = { workers: RegistryWorker[]; cutover: boolean };

export function scenarioDynamoConfig(): DynamoDBClientConfig {
  const endpoint = process.env.TEST_DYNAMODB_ENDPOINT;
  if (!endpoint) throw new Error("TEST_DYNAMODB_ENDPOINT is required");
  return {
    endpoint,
    region: "local",
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
    maxAttempts: 1,
  };
}

async function queryAll(
  client: DynamoDBClient,
  input: ConstructorParameters<typeof QueryCommand>[0],
) {
  const items: ReturnType<typeof unmarshall>[] = [];
  let ExclusiveStartKey: QueryCommand["input"]["ExclusiveStartKey"];
  do {
    const page = await client.send(
      new QueryCommand({ ...input, ExclusiveStartKey, ConsistentRead: true }),
    );
    items.push(...(page.Items ?? []).map((item) => unmarshall(item)));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** Real local tables under a random prefix, plus direct row reads that bypass every worker gate. */
export async function createScenarioTables() {
  const prefix = `scenario-${randomUUID()}-`;
  const client = new DynamoDBClient(scenarioDynamoConfig());
  const table = (name: string) => prefix + name;
  await runDynamoInitializationAgainst(scenarioDynamoConfig(), prefix);

  async function tableNames(): Promise<string[]> {
    const names: string[] = [];
    let ExclusiveStartTableName: string | undefined;
    do {
      const page = await client.send(
        new ListTablesCommand({ ExclusiveStartTableName }),
      );
      names.push(...(page.TableNames ?? []));
      ExclusiveStartTableName = page.LastEvaluatedTableName;
    } while (ExclusiveStartTableName);
    return names.filter((name) => name.startsWith(prefix));
  }

  return {
    prefix,
    tableNames,
    rows: {
      async history(guildId: string): Promise<MeetingHistory[]> {
        const rows = await queryAll(client, {
          TableName: table("MeetingHistoryTable"),
          KeyConditionExpression: "guildId = :guildId",
          ExpressionAttributeValues: marshall({ ":guildId": guildId }),
        });
        return rows as MeetingHistory[];
      },
      async seedHistory(row: MeetingHistory): Promise<void> {
        await client.send(
          new PutItemCommand({
            TableName: table("MeetingHistoryTable"),
            Item: marshall(row, { removeUndefinedValues: true }),
          }),
        );
      },
      /** Writes any item as the portal or an earlier configuration would have left it. */
      async put(tableName: string, item: object): Promise<void> {
        await client.send(
          new PutItemCommand({
            TableName: table(tableName),
            Item: marshall(item, { removeUndefinedValues: true }),
          }),
        );
      },
      async get(
        tableName: string,
        key: Record<string, string>,
      ): Promise<Record<string, unknown> | undefined> {
        const result = await client.send(
          new GetItemCommand({
            TableName: table(tableName),
            Key: marshall(key),
            ConsistentRead: true,
          }),
        );
        return result.Item && unmarshall(result.Item);
      },
      async lease(guildId: string): Promise<ActiveMeetingLease | undefined> {
        const result = await client.send(
          new GetItemCommand({
            TableName: table("ActiveMeetingTable"),
            Key: marshall({ guildId }),
            ConsistentRead: true,
          }),
        );
        return result.Item && (unmarshall(result.Item) as ActiveMeetingLease);
      },
      async registry(): Promise<RegistryView> {
        const items = await queryAll(client, {
          TableName: table("DeploymentControlTable"),
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: marshall({ ":pk": WORKERS_PK }),
        });
        return {
          workers: items.filter(
            (item) => item.recordType === "worker",
          ) as RegistryWorker[],
          cutover: items.some((item) => item.sk === CUTOVER_SK),
        };
      },
    },
    async seedLegacyRuntime(heartbeatAt: number): Promise<void> {
      await client.send(
        new PutItemCommand({
          TableName: table("DeploymentControlTable"),
          Item: marshall({
            pk: LEGACY_RUNTIME_PK,
            sk: `RUNTIME#legacy-${randomUUID()}`,
            heartbeatAt,
          }),
        }),
      );
    },
    async dispose(): Promise<void> {
      for (const TableName of await tableNames())
        await client.send(new DeleteTableCommand({ TableName }));
      client.destroy();
    },
  };
}
