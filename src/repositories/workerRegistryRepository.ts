import {
  type DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { config } from "../services/configService";
import { classifyDeploymentTransactionError } from "./deploymentControlErrors";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { getMockStore } from "./mockStore";

export const WORKERS_PK = "WORKERS";
const CUTOVER_SK = "CUTOVER";
const LEGACY_PK = "ENV";
const LEGACY_RUNTIME_SK_PREFIX = "RUNTIME#";

export type WorkerRecord = {
  pk: "WORKERS";
  sk: `WORKER#${string}`;
  recordType: "worker";
  instanceId: string;
  release: number;
  ready: boolean;
  heartbeatAt: number;
  captures: number;
  finishing: number;
  protectedUntil?: number;
  taskArn?: string;
  expiresAt: number;
};
export type RegistryView = { workers: WorkerRecord[]; cutover: boolean };
export type WorkerRegistryRepository = {
  put(record: WorkerRecord): Promise<void>;
  read(): Promise<RegistryView>;
  writeCutover(instanceId: string, now: number): Promise<void>;
  legacyHeartbeats(): Promise<number[]>;
};

type CutoverRecord = {
  pk: "WORKERS";
  sk: "CUTOVER";
  recordType: "cutover";
  cutoverAt: number;
  instanceId: string;
};
export type RegistryItem = WorkerRecord | CutoverRecord;
/** Only the attributes the legacy heartbeat read projects; the rest of an old row is never interpreted. */
export type LegacyRow = { pk: string; sk: string; heartbeatAt?: unknown };

const workerRecordSchema = z.object({
  pk: z.literal(WORKERS_PK),
  sk: z.templateLiteral(["WORKER#", z.string()]),
  recordType: z.literal("worker"),
  instanceId: z.string(),
  release: z.number(),
  ready: z.boolean(),
  heartbeatAt: z.number(),
  captures: z.number(),
  finishing: z.number(),
  protectedUntil: z.number().optional(),
  taskArn: z.string().optional(),
  expiresAt: z.number(),
});

function toView(items: Iterable<Record<string, unknown>>): RegistryView {
  const view: RegistryView = { workers: [], cutover: false };
  for (const item of items) {
    if (item.sk === CUTOVER_SK) {
      view.cutover = true;
      continue;
    }
    const parsed = workerRecordSchema.safeParse(item);
    if (parsed.success) view.workers.push(parsed.data);
  }
  return view;
}

function numericHeartbeats(rows: Iterable<{ heartbeatAt?: unknown }>) {
  const heartbeats: number[] = [];
  for (const row of rows) {
    const parsed = z.number().safeParse(row.heartbeatAt);
    if (parsed.success) heartbeats.push(parsed.data);
  }
  return heartbeats;
}

function cutoverRecord(instanceId: string, now: number): CutoverRecord {
  return {
    pk: WORKERS_PK,
    sk: CUTOVER_SK,
    recordType: "cutover",
    cutoverAt: now,
    instanceId,
  };
}

export function createDynamoWorkerRegistryRepository(
  client: DynamoDBClient,
  table: string,
): WorkerRegistryRepository {
  async function queryAll(input: Omit<QueryCommandInput, "TableName">) {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
    do {
      const page = await client.send(
        new QueryCommand({ ...input, TableName: table, ExclusiveStartKey }),
      );
      for (const item of page.Items ?? []) items.push(unmarshall(item));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  return {
    async put(record) {
      await client.send(
        new PutItemCommand({
          TableName: table,
          Item: marshall(record, { removeUndefinedValues: true }),
        }),
      );
    },
    async read() {
      return toView(
        await queryAll({
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: marshall({ ":pk": WORKERS_PK }),
          ConsistentRead: true,
        }),
      );
    },
    async writeCutover(instanceId, now) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: marshall(cutoverRecord(instanceId, now)),
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (error) {
        // The marker is permanent, so finding one already written is the goal reached.
        if (classifyDeploymentTransactionError(error) !== "stale") throw error;
      }
    },
    async legacyHeartbeats() {
      return numericHeartbeats(
        await queryAll({
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: marshall({
            ":pk": LEGACY_PK,
            ":prefix": LEGACY_RUNTIME_SK_PREFIX,
          }),
          ProjectionExpression: "heartbeatAt",
        }),
      );
    },
  };
}

export function createMockWorkerRegistryRepository(
  items: Map<string, RegistryItem>,
  legacyRows: ReadonlyMap<string, LegacyRow>,
): WorkerRegistryRepository {
  return {
    async put(record) {
      items.set(record.sk, structuredClone(record));
    },
    async read() {
      return structuredClone(toView(items.values()));
    },
    async writeCutover(instanceId, now) {
      if (!items.has(CUTOVER_SK))
        items.set(CUTOVER_SK, cutoverRecord(instanceId, now));
    },
    async legacyHeartbeats() {
      return numericHeartbeats(
        [...legacyRows.values()].filter(
          (row) =>
            row.pk === LEGACY_PK && row.sk.startsWith(LEGACY_RUNTIME_SK_PREFIX),
        ),
      );
    },
  };
}

const mockRegistries = new WeakMap<object, Map<string, RegistryItem>>();
let nativeRepository: WorkerRegistryRepository | undefined;
export function getWorkerRegistryRepository(): WorkerRegistryRepository {
  if (!config.mock.enabled) {
    nativeRepository ??= createDynamoWorkerRegistryRepository(
      dynamoDbClient,
      tableName("DeploymentControlTable"),
    );
    return nativeRepository;
  }
  const store = getMockStore();
  let items = mockRegistries.get(store);
  if (!items) {
    items = new Map();
    mockRegistries.set(store, items);
  }
  return createMockWorkerRegistryRepository(
    items,
    store.deploymentControlRecords,
  );
}
