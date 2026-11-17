import {
  GetItemCommand,
  TransactWriteItemsCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../services/configService";
import { fetchJsonFromS3, uploadObjectToS3 } from "../services/storageService";
import {
  type AskRunRecord,
  type AskRunScope,
  isAskRunActive,
} from "../types/askRun";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { getMockStore } from "./mockStore";

export type AskRunRepository = {
  get(scope: AskRunScope, runId: string): Promise<AskRunRecord | undefined>;
  getActive(scope: AskRunScope): Promise<AskRunRecord | undefined>;
  getPrivateState(scope: AskRunScope): Promise<unknown>;
  create(record: AskRunRecord): Promise<boolean>;
  replace(
    previous: AskRunRecord,
    next: AskRunRecord,
    now: number,
    expired?: boolean,
  ): Promise<boolean>;
};
const scopeKey = (scope: AskRunScope) =>
  `ASKRUN#${createHash("sha256")
    .update(JSON.stringify([scope.userId, scope.guildId, scope.conversationId]))
    .digest("hex")}`;
const key = (scope: AskRunScope, sk: string) => ({ pk: scopeKey(scope), sk });
const clone = <T>(value: T): T => structuredClone(value);
const validWrite = (
  current: AskRunRecord | undefined,
  previous: AskRunRecord,
  now: number,
  expired: boolean,
) =>
  current?.version === previous.version &&
  current.ownerToken === previous.ownerToken &&
  isAskRunActive(current.snapshot.status) &&
  (expired ? current.leaseExpiresAt <= now : current.leaseExpiresAt > now);

export function createMemoryAskRunRepository(): AskRunRepository {
  const runs = new Map<string, AskRunRecord>();
  const active = new Map<string, string>();
  const privateStates = new Map<string, unknown>();
  const id = (scope: AskRunScope, runId: string) =>
    JSON.stringify([scopeKey(scope), runId]);
  return {
    async get(scope, runId) {
      return clone(runs.get(id(scope, runId)));
    },
    async getActive(scope) {
      const runId = active.get(scopeKey(scope));
      return runId ? clone(runs.get(id(scope, runId))) : undefined;
    },
    async getPrivateState(scope) {
      return clone(privateStates.get(scopeKey(scope)));
    },
    async create(record) {
      const partition = scopeKey(record.input);
      const runKey = id(record.input, record.snapshot.runId);
      if (runs.has(runKey) || active.has(partition)) return false;
      runs.set(runKey, clone(record));
      active.set(partition, record.snapshot.runId);
      return true;
    },
    async replace(previous, next, now, expired = false) {
      const runKey = id(previous.input, previous.snapshot.runId);
      if (!validWrite(runs.get(runKey), previous, now, expired)) return false;
      runs.set(runKey, clone(next));
      if (!isAskRunActive(next.snapshot.status)) {
        active.delete(scopeKey(previous.input));
        if (next.snapshot.status === "completed")
          privateStates.set(scopeKey(previous.input), clone(next.privateState));
      }
      return true;
    },
  };
}

type StoredRun = Omit<AskRunRecord, "privateState"> & {
  pk: string;
  sk: string;
  privateStateKey?: string;
  payloadKey?: string;
};
const conditionalFailure = (error: unknown) => {
  const failure = error as {
    name?: string;
    CancellationReasons?: { Code?: string }[];
  };
  return (
    failure.name === "TransactionCanceledException" &&
    !!failure.CancellationReasons?.some(
      (reason) => reason.Code === "ConditionalCheckFailed",
    )
  );
};

export function createDynamoAskRunRepository(
  client: Pick<DynamoDBClient, "send"> = dynamoDbClient,
): AskRunRepository {
  const TableName = tableName("AskConversationTable");
  async function read<T>(
    scope: AskRunScope,
    sk: string,
  ): Promise<T | undefined> {
    const result = await client.send(
      new GetItemCommand({
        TableName,
        Key: marshall(key(scope, sk)),
        ConsistentRead: true,
      }),
    );
    return result.Item ? (unmarshall(result.Item) as T) : undefined;
  }
  async function putBlob(record: AskRunRecord, kind: string, payload: unknown) {
    const objectKey = `${config.storage.transcriptPrefix}ask-runs/${scopeKey(record.input)}/${record.snapshot.runId}/${record.version}-${randomUUID()}-${kind}.json`;
    if (
      !(await uploadObjectToS3(
        objectKey,
        JSON.stringify(payload),
        "application/json",
        { immutable: true },
      ))
    )
      throw new Error("Ask run storage unavailable");
    return objectKey;
  }
  async function encode(record: AskRunRecord): Promise<StoredRun> {
    const { privateState, ...rest } = record;
    const item: StoredRun = {
      ...rest,
      ...key(record.input, `RUN#${record.snapshot.runId}`),
    };
    if (privateState !== undefined)
      item.privateStateKey = await putBlob(record, "private", privateState);
    if (Buffer.byteLength(JSON.stringify(item)) > 240_000) {
      item.payloadKey = await putBlob(record, "payload", {
        input: record.input,
        snapshot: record.snapshot,
      });
      item.input = {
        ...record.input,
        question: "",
        contextMeetingIds: undefined,
      };
      item.snapshot = {
        ...record.snapshot,
        question: "",
        text: "",
        activity: undefined,
        result: undefined,
      };
    }
    return item;
  }
  async function decode(item: StoredRun | undefined) {
    if (!item) return undefined;
    let payload: Pick<AskRunRecord, "input" | "snapshot"> | undefined;
    if (item.payloadKey) {
      payload = await fetchJsonFromS3(item.payloadKey);
      if (!payload) throw new Error("Ask run payload unavailable");
    }
    let privateState: unknown;
    if (item.privateStateKey) {
      privateState = await fetchJsonFromS3(item.privateStateKey);
      if (privateState === undefined)
        throw new Error("Ask run private history unavailable");
    }
    return {
      input: payload?.input ?? item.input,
      snapshot: payload?.snapshot ?? item.snapshot,
      ownerToken: item.ownerToken,
      version: item.version,
      leaseExpiresAt: item.leaseExpiresAt,
      privateState,
    };
  }
  return {
    async get(scope, runId) {
      return decode(await read<StoredRun>(scope, `RUN#${runId}`));
    },
    async getActive(scope) {
      const active = await read<{ runId: string }>(scope, "ACTIVE");
      return active
        ? decode(await read<StoredRun>(scope, `RUN#${active.runId}`))
        : undefined;
    },
    async getPrivateState(scope) {
      const state = await read<{ privateStateKey?: string }>(scope, "PRIVATE");
      if (!state?.privateStateKey) return undefined;
      const value = await fetchJsonFromS3(state.privateStateKey);
      if (value === undefined)
        throw new Error("Ask run private history unavailable");
      return value;
    },
    async create(record) {
      const item = await encode(record);
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName,
                  Item: marshall(item, { removeUndefinedValues: true }),
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Put: {
                  TableName,
                  Item: marshall({
                    ...key(record.input, "ACTIVE"),
                    runId: record.snapshot.runId,
                  }),
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },
    async replace(previous, next, now, expired = false) {
      const encodingStartedAt = Date.now();
      const item = await encode(next);
      const transaction: ConstructorParameters<
        typeof TransactWriteItemsCommand
      >[0]["TransactItems"] = [
        {
          Put: {
            TableName,
            Item: marshall(item, { removeUndefinedValues: true }),
            ConditionExpression:
              "#version = :version AND ownerToken = :owner AND leaseExpiresAt " +
              (expired ? "<= :now" : "> :now") +
              " AND (#snapshot.#status = :queued OR #snapshot.#status = :running)",
            ExpressionAttributeNames: {
              "#version": "version",
              "#snapshot": "snapshot",
              "#status": "status",
            },
            ExpressionAttributeValues: marshall({
              ":version": previous.version,
              ":owner": previous.ownerToken,
              ":now": now + (Date.now() - encodingStartedAt),
              ":queued": "queued",
              ":running": "running",
            }),
          },
        },
      ];
      if (!isAskRunActive(next.snapshot.status)) {
        transaction.push({
          Delete: {
            TableName,
            Key: marshall(key(previous.input, "ACTIVE")),
            ConditionExpression: "runId = :run",
            ExpressionAttributeValues: marshall({
              ":run": previous.snapshot.runId,
            }),
          },
        });
        if (next.snapshot.status === "completed")
          transaction.push({
            Put: {
              TableName,
              Item: marshall(
                {
                  ...key(next.input, "PRIVATE"),
                  privateStateKey: item.privateStateKey,
                },
                { removeUndefinedValues: true },
              ),
            },
          });
      }
      try {
        await client.send(
          new TransactWriteItemsCommand({ TransactItems: transaction }),
        );
        return true;
      } catch (error) {
        if (conditionalFailure(error)) return false;
        throw error;
      }
    },
  };
}
const memoryRepositories = new WeakMap<object, AskRunRepository>();
let dynamoRepository: AskRunRepository | undefined;
export function getAskRunRepository() {
  if (!config.mock.enabled)
    return (dynamoRepository ??= createDynamoAskRunRepository());
  const store = getMockStore();
  let repository = memoryRepositories.get(store);
  if (!repository) {
    repository = createMemoryAskRunRepository();
    memoryRepositories.set(store, repository);
  }
  return repository;
}
