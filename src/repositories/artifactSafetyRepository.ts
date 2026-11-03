import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { conditional, type ConditionalResult } from "./deploymentControlErrors";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import { stableJson } from "../utils/stableJson";
import {
  sameRuntimeIdentity,
  type RuntimeIdentity,
  type DeploymentControlRecord,
} from "../types/deploymentControl";
import type { MeetingHistory } from "../types/db";
import {
  artifactSafetyKey,
  artifactSafetyRecordSchema,
  type ArtifactSafetyRecord,
} from "../types/artifactSafety";
import {
  buildArtifactSafetyTransaction,
  artifactExpectedAttributes,
  artifactRuntimeAttributes,
  artifactControlAttributes,
  artifactHistoryAttributes,
  artifactPreparationControl,
  type ArtifactSafetyTables,
  type ArtifactSafetyWrite,
} from "../services/artifactSafetyTransactions";
import { artifactProofForWrite } from "../services/artifactSafetyRules";

export type ArtifactSafetyRepository = {
  read(
    identity: RuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<ArtifactSafetyRecord | undefined>;
  write(
    input: ArtifactSafetyWrite,
    signal?: AbortSignal,
  ): Promise<ConditionalResult>;
};
function parseRecord(value: unknown, identity: RuntimeIdentity) {
  const record = artifactSafetyRecordSchema.parse(value);
  if (!sameRuntimeIdentity(record.identity, identity))
    throw new Error("Artifact capability identity differs");
  return record;
}
export function createDynamoArtifactSafetyRepository(
  client: DynamoDBClient,
  tables: ArtifactSafetyTables,
): ArtifactSafetyRepository {
  async function read(identity: RuntimeIdentity, signal?: AbortSignal) {
    const result = await client.send(
      new GetItemCommand({
        TableName: tables.deploymentControl,
        Key: marshall(artifactSafetyKey(identity)),
        ConsistentRead: true,
      }),
      { abortSignal: signal },
    );
    return result.Item
      ? parseRecord(unmarshall(result.Item), identity)
      : undefined;
  }
  return {
    read,
    async write(input, signal) {
      const transaction = buildArtifactSafetyTransaction(input, tables);
      try {
        return await conditional(() =>
          client.send(new TransactWriteItemsCommand(transaction), {
            abortSignal: signal,
          }),
        );
      } catch (error) {
        const observed = await read(input.next.identity, signal).catch(
          () => undefined,
        );
        if (observed && stableJson(observed) === stableJson(input.next))
          return "applied";
        throw error;
      }
    },
  };
}
function valueAtPath(value: unknown, field: string): unknown {
  return field
    .split(".")
    .reduce<unknown>(
      (current, part) =>
        current !== null && typeof current === "object"
          ? Reflect.get(current, part)
          : undefined,
      value,
    );
}
function matches(value: unknown, attributes: Record<string, unknown>) {
  if (value === undefined) return false;
  return Object.entries(attributes).every(([field, expected]) => {
    const current = valueAtPath(value, field);
    return expected === null
      ? current === undefined
      : stableJson(current) === stableJson(expected);
  });
}
type MockArtifactWorld = {
  records: Map<string, DeploymentControlRecord>;
  artifacts: Map<string, ArtifactSafetyRecord>;
  histories: Map<string, MeetingHistory[]>;
};
function runtimeMatches(world: MockArtifactWorld, input: ArtifactSafetyWrite) {
  const row = world.records.get(
    JSON.stringify(["ENV", "RUNTIME#" + input.next.identity.instanceId]),
  );
  if (
    row?.recordType !== "runtime" ||
    !matches(row, artifactRuntimeAttributes(input))
  )
    return false;
  return (
    ["heartbeat", "block", "cancel"].includes(input.purpose) ||
    (row.protection.expiresAt > input.now &&
      sameRuntimeIdentity(row.protection.identity, input.next.identity))
  );
}
function controlMatches(world: MockArtifactWorld, input: ArtifactSafetyWrite) {
  if (input.context.kind === "runtime") return true;
  const row = world.records.get(JSON.stringify(["ENV", "CONTROL"]));
  return (
    row?.recordType === "control" &&
    matches(row, artifactControlAttributes(input.context.control)) &&
    (input.context.kind === "activating" ||
      row.coordinatorExpiresAt > input.now)
  );
}
function historiesMatch(world: MockArtifactWorld, input: ArtifactSafetyWrite) {
  return (artifactProofForWrite(input)?.snapshot.authorities ?? []).every(
    (authority) => {
      const row = world.histories
        .get(authority.owner.guildId)
        ?.find((item) => item.channelId_timestamp === authority.historyKey);
      return matches(row, artifactHistoryAttributes(authority));
    },
  );
}
export function createMockArtifactSafetyRepository(
  world: MockArtifactWorld,
): ArtifactSafetyRepository {
  return {
    async read(identity, signal) {
      signal?.throwIfAborted();
      const record = world.artifacts.get(artifactSafetyKey(identity).sk);
      return record
        ? parseRecord(structuredClone(record), identity)
        : undefined;
    },
    async write(input, signal) {
      signal?.throwIfAborted();
      buildArtifactSafetyTransaction(input, {
        deploymentControl: "mock",
        meetingHistory: "mock",
      });
      const current = world.artifacts.get(input.next.sk);
      const unchanged = input.expected
        ? matches(current, artifactExpectedAttributes(input.expected))
        : current === undefined;
      if (
        !unchanged ||
        !runtimeMatches(world, input) ||
        !controlMatches(world, input) ||
        !historiesMatch(world, input)
      )
        return "stale";
      world.artifacts.set(
        input.next.sk,
        artifactSafetyRecordSchema.parse(structuredClone(input.next)),
      );
      if (
        ["consume", "cancel_ack"].includes(input.purpose) &&
        input.context.kind === "preparing"
      )
        world.records.set(
          JSON.stringify(["ENV", "CONTROL"]),
          artifactPreparationControl(
            input.context.control,
            input.now,
            input.purpose === "consume" ? "warming" : "complete",
          ),
        );
      return "applied";
    },
  };
}
const mockArtifacts = new WeakMap<object, Map<string, ArtifactSafetyRecord>>();
let nativeRepository: ArtifactSafetyRepository | undefined;
export function getArtifactSafetyRepository(): ArtifactSafetyRepository {
  if (!config.mock.enabled) {
    nativeRepository ??= createDynamoArtifactSafetyRepository(dynamoDbClient, {
      deploymentControl: tableName("DeploymentControlTable"),
      meetingHistory: tableName("MeetingHistoryTable"),
    });
    return nativeRepository;
  }
  const store = getMockStore();
  let artifacts = mockArtifacts.get(store);
  if (!artifacts) {
    artifacts = new Map();
    mockArtifacts.set(store, artifacts);
  }
  return createMockArtifactSafetyRepository({
    records: store.deploymentControlRecords,
    histories: store.meetingHistoryByGuild,
    artifacts,
  });
}
