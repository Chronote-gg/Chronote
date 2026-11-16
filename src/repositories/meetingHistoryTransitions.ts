import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type PutItemCommandInput,
  type TransactWriteItem,
  type TransactWriteItemsCommandInput,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { ActiveMeetingLease, MeetingHistory } from "../types/db";
import {
  publicationSnapshotCondition,
  settledLifecycleDelivery,
} from "../types/meetingPublication";
import {
  validateHistoryTransition,
  type ControlTableNames,
  type HistoryKey,
  type HistoryTransition,
  type SessionOwnership,
} from "../types/meetingHistoryTransition";
import { conditional } from "./deploymentControlErrors";
import {
  applyMockOwnedHistoryTransition,
  matchesOwnedHistoryTransition,
} from "./meetingHistoryTransitionState";
import { config } from "../services/configService";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { getMockStore } from "./mockStore";

export type MeetingHistoryTransitionRepository = {
  transitionMeetingHistory(
    input: HistoryTransition,
  ): Promise<"applied" | "stale">;
  getMeetingHistory(
    key: HistoryKey,
    signal?: AbortSignal,
  ): Promise<MeetingHistory | undefined>;
};

export function leaseOwnershipCheck(
  ownership: SessionOwnership,
  now: number,
  tables: ControlTableNames,
): TransactWriteItem {
  if (!tables.activeMeeting)
    throw new Error("Active meeting table is required");
  return {
    ConditionCheck: {
      TableName: tables.activeMeeting,
      Key: marshall({ guildId: ownership.guildId }),
      ConditionExpression:
        "meetingId = :meeting AND ownerInstanceId = :owner AND executionVersion = :version AND voiceOperationAttemptId = :attempt AND leaseExpiresAt >= :now AND sessionMode = :sessionMode",
      ExpressionAttributeValues: marshall({
        ":meeting": ownership.meetingId,
        ":owner": ownership.ownerInstanceId,
        ":version": ownership.executionVersion,
        ":attempt": ownership.voiceOperationAttemptId,
        ":now": now,
        ":sessionMode": "meeting",
      }),
    },
  };
}

export function buildInitialMeetingHistoryPut(
  history: MeetingHistory,
  tables: ControlTableNames,
): PutItemCommandInput {
  if (
    !history.ownerInstanceId ||
    history.executionVersion !== 1 ||
    history.status !== "starting"
  )
    throw new Error(
      "Initial history requires starting status, owner and execution version 1",
    );
  return {
    TableName: tables.meetingHistory,
    Item: marshall(history, { removeUndefinedValues: true }),
    ConditionExpression:
      "attribute_not_exists(guildId) AND attribute_not_exists(channelId_timestamp)",
  };
}

export function buildHistoryTransition(
  input: HistoryTransition,
  tables: ControlTableNames,
): UpdateItemCommandInput & { UpdateExpression: string } {
  validateHistoryTransition(input);
  const names: Record<string, string> = { "#status": "status" };
  const values = marshall({
    ":meeting": input.expectedMeetingId,
    ":owner": input.expectedOwnerInstanceId,
    ":version": input.expectedExecutionVersion,
    ":prior": input.expectedStatus,
  });
  // The version fences the execution attempt shared with its lease. Only an
  // ownership/recovery transaction may advance it, never lifecycle progress.
  const updates: string[] = [];
  Object.entries(input.patch).forEach(([field, value], index) => {
    if (value === undefined) return;
    names[`#field${index}`] = field;
    Object.assign(
      values,
      marshall({ [`:value${index}`]: value }, { removeUndefinedValues: true }),
    );
    updates.push(`#field${index} = :value${index}`);
  });
  let publicationCondition = "";
  if (input.expectedPublication) {
    const proof = publicationSnapshotCondition(input.expectedPublication);
    Object.assign(names, proof.names);
    Object.assign(
      values,
      marshall(proof.values, { removeUndefinedValues: true }),
    );
    publicationCondition = " AND " + proof.condition;
    const settled = settledLifecycleDelivery(
      input.expectedPublication,
      input.patch,
    );
    if (settled) {
      names["#settledDelivery"] = "updateDelivery";
      updates.push("#settledDelivery = :settledDelivery");
      Object.assign(values, marshall({ ":settledDelivery": settled.delivery }));
      if (settled.dueAt !== undefined) {
        names["#settledQueue"] = "updateDeliveryQueue";
        names["#settledDue"] = "updateDeliveryDueAt";
        updates.push(
          "#settledQueue = :settledQueue",
          "#settledDue = :settledDue",
        );
        Object.assign(
          values,
          marshall({
            ":settledQueue": "meeting-update:v1",
            ":settledDue": settled.dueAt,
          }),
        );
      }
    }
  }
  let checkpointCondition = "";
  if (input.expectedCheckpointRevision !== undefined) {
    names["#checkpoint"] = "checkpoint";
    if (input.expectedCheckpointRevision === 0) {
      checkpointCondition = " AND attribute_not_exists(#checkpoint)";
    } else {
      names["#revision"] = "revision";
      Object.assign(
        values,
        marshall({ ":checkpointRevision": input.expectedCheckpointRevision }),
      );
      checkpointCondition = " AND #checkpoint.#revision = :checkpointRevision";
    }
  }
  return {
    TableName: tables.meetingHistory,
    Key: marshall(input.key),
    ConditionExpression:
      "meetingId = :meeting AND ownerInstanceId = :owner AND executionVersion = :version AND #status = :prior" +
      checkpointCondition +
      publicationCondition,
    UpdateExpression: `SET ${updates.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

function leaseProof(input: HistoryTransition) {
  return input.completionPolicyProof ?? input.checkpointPublication;
}

/** Checkpoint publication continues the original lease, including after promotion. */
export function buildOwnedCheckpointTransition(
  input: HistoryTransition,
  tables: ControlTableNames,
): TransactWriteItemsCommandInput {
  const update = buildHistoryTransition(input, tables);
  const proof = leaseProof(input);
  if (!proof || !tables.activeMeeting)
    throw new Error("Checkpoint publication requires its active lease table");
  return {
    TransactItems: [
      leaseOwnershipCheck(proof.ownership, proof.now, tables),
      {
        Update: {
          ...update,
          TableName: tables.meetingHistory,
          Key: marshall(input.key),
        },
      },
    ],
  };
}

export function createDynamoMeetingHistoryTransitionRepository(
  client: DynamoDBClient,
  tables: ControlTableNames,
): MeetingHistoryTransitionRepository {
  return {
    transitionMeetingHistory: (input) =>
      conditional(() =>
        leaseProof(input)
          ? client.send(
              new TransactWriteItemsCommand(
                buildOwnedCheckpointTransition(input, tables),
              ),
              { abortSignal: input.signal },
            )
          : client.send(
              new UpdateItemCommand(buildHistoryTransition(input, tables)),
              { abortSignal: input.signal },
            ),
      ),
    async getMeetingHistory(key, signal) {
      signal?.throwIfAborted();
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.meetingHistory,
          Key: marshall(key),
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      );
      return result.Item
        ? (unmarshall(result.Item) as MeetingHistory)
        : undefined;
    },
  };
}

function mockLeaseOwned(
  ownership: SessionOwnership,
  now: number,
  leases: Map<string, ActiveMeetingLease>,
): boolean {
  const lease = leases.get(ownership.guildId);
  return Boolean(
    lease &&
    lease.sessionMode === "meeting" &&
    lease.meetingId === ownership.meetingId &&
    lease.ownerInstanceId === ownership.ownerInstanceId &&
    lease.executionVersion === ownership.executionVersion &&
    lease.voiceOperationAttemptId === ownership.voiceOperationAttemptId &&
    lease.leaseExpiresAt >= now,
  );
}

const MOCK_TABLES: ControlTableNames = {
  deploymentControl: "mock",
  meetingHistory: "mock",
};

export function createMockMeetingHistoryTransitionRepository(
  histories: Map<string, MeetingHistory[]>,
  leases: Map<string, ActiveMeetingLease>,
): MeetingHistoryTransitionRepository {
  const getHistory = (key: HistoryKey) =>
    histories
      .get(key.guildId)
      ?.find((row) => row.channelId_timestamp === key.channelId_timestamp);
  return {
    async transitionMeetingHistory(input) {
      input.signal?.throwIfAborted();
      buildHistoryTransition(input, MOCK_TABLES);
      const row = getHistory(input.key);
      const proof = leaseProof(input);
      if (proof && !mockLeaseOwned(proof.ownership, proof.now, leases))
        return "stale";
      if (!matchesOwnedHistoryTransition(row, input)) return "stale";
      applyMockOwnedHistoryTransition(row, input);
      return "applied";
    },
    async getMeetingHistory(key, signal) {
      signal?.throwIfAborted();
      const row = getHistory(key);
      return row ? structuredClone(row) : undefined;
    },
  };
}

export function getMeetingHistoryTransitionRepository(): MeetingHistoryTransitionRepository {
  if (!config.mock.enabled)
    return createDynamoMeetingHistoryTransitionRepository(dynamoDbClient, {
      deploymentControl: tableName("DeploymentControlTable"),
      meetingHistory: tableName("MeetingHistoryTable"),
      activeMeeting: tableName("ActiveMeetingTable"),
    });
  const store = getMockStore();
  return createMockMeetingHistoryTransitionRepository(
    store.meetingHistoryByGuild,
    store.activeMeetingLeases,
  );
}
