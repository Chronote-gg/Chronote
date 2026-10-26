import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DynamoDBClient,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import type {
  MeetingControlCommand,
  MeetingControlCommandResult,
} from "../types/meetingControl";
import type {
  WorkAdmissionAuthority,
  ControlTableNames,
} from "../types/deploymentControl";
import { buildWorkAdmissionChecks } from "../services/deploymentControlTransactions";
import {
  classifyDeploymentTransactionError,
  mockWorkAdmissionAllowed,
} from "./deploymentControlRepository";
import { getMockStore } from "./mockStore";

const PENDING_STATUS = "pending";
const STATUS_CREATED_AT_INDEX = "StatusCreatedAtIndex";

export type ClaimMeetingControlCommandInput = {
  requestId: string;
  instanceId: string;
  nowEpochSeconds: number;
  claimExpiresAt: number;
  updatedAt: string;
  claimId: string;
  authority: WorkAdmissionAuthority;
};

export type CompleteMeetingControlCommandInput = {
  requestId: string;
  instanceId: string;
  updatedAt: string;
  result: MeetingControlCommandResult;
  claimId: string;
  nowEpochSeconds: number;
};

export type FailMeetingControlCommandInput = {
  requestId: string;
  instanceId: string;
  updatedAt: string;
  error: string;
  claimId: string;
  nowEpochSeconds: number;
};

export type MeetingControlCommandRepository = {
  renewCommand: (
    input: Omit<ClaimMeetingControlCommandInput, "authority">,
  ) => Promise<boolean>;
  writeCommand: (command: MeetingControlCommand) => Promise<void>;
  getCommand: (requestId: string) => Promise<MeetingControlCommand | undefined>;
  listClaimablePendingCommands: (options: {
    instanceId: string;
    nowEpochSeconds: number;
    limit: number;
  }) => Promise<MeetingControlCommand[]>;
  claimCommand: (
    input: ClaimMeetingControlCommandInput,
  ) => Promise<MeetingControlCommand | undefined>;
  completeCommand: (
    input: CompleteMeetingControlCommandInput,
  ) => Promise<boolean>;
  failCommand: (
    input: FailMeetingControlCommandInput,
    signal?: AbortSignal,
  ) => Promise<boolean>;
};

const tableName = `${config.database.tablePrefix ?? ""}MeetingControlCommandTable`;

const dynamoDbClient = new DynamoDBClient(
  config.database.useLocalDynamoDB
    ? {
        endpoint: "http://localhost:8000",
        region: "local",
        credentials: {
          accessKeyId: "dummy",
          secretAccessKey: "dummy",
        },
      }
    : { region: config.storage.awsRegion },
);

const commandKey = (requestId: string) => ({ requestId });

const isConditionalFailure = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

function validClaimAuthority(
  command: MeetingControlCommand,
  input: ClaimMeetingControlCommandInput,
): boolean {
  if (input.authority.kind === "serving")
    return (
      input.instanceId === input.authority.context.instanceId &&
      !command.targetOwnerInstanceId
    );
  const owner = input.authority.ownership;
  return (
    command.commandType !== "start_meeting" &&
    input.instanceId === owner.ownerInstanceId &&
    command.input.serverId === owner.guildId &&
    (!command.targetOwnerInstanceId ||
      command.targetOwnerInstanceId === owner.ownerInstanceId) &&
    (!("meetingId" in command.input) ||
      !command.input.meetingId ||
      command.input.meetingId === owner.meetingId)
  );
}
export function createDynamoMeetingControlCommandRepository(
  dynamoDbClient: DynamoDBClient,
  tableName: string,
  tables: ControlTableNames,
): MeetingControlCommandRepository {
  const repository: MeetingControlCommandRepository = {
    async writeCommand(command) {
      await dynamoDbClient.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall(command, { removeUndefinedValues: true }),
          ConditionExpression: "attribute_not_exists(#requestId)",
          ExpressionAttributeNames: { "#requestId": "requestId" },
        }),
      );
    },
    async getCommand(requestId) {
      const result = await dynamoDbClient.send(
        new GetItemCommand({
          TableName: tableName,
          Key: marshall(commandKey(requestId)),
          ConsistentRead: true,
        }),
      );
      return result.Item
        ? (unmarshall(result.Item) as MeetingControlCommand)
        : undefined;
    },
    async listClaimablePendingCommands({ instanceId, nowEpochSeconds, limit }) {
      const commands: MeetingControlCommand[] = [];
      let exclusiveStartKey: Record<string, AttributeValue> | undefined;

      do {
        const result = await dynamoDbClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: STATUS_CREATED_AT_INDEX,
            KeyConditionExpression: "#queueStatus = :pending",
            FilterExpression:
              "#expiresAt > :nowEpochSeconds AND (attribute_not_exists(#targetOwnerInstanceId) OR #targetOwnerInstanceId = :instanceId) AND (attribute_not_exists(#claimExpiresAt) OR #claimExpiresAt < :nowEpochSeconds OR #claimedByInstanceId = :instanceId)",
            ExpressionAttributeNames: {
              "#queueStatus": "queueStatus",
              "#expiresAt": "expiresAt",
              "#targetOwnerInstanceId": "targetOwnerInstanceId",
              "#claimExpiresAt": "claimExpiresAt",
              "#claimedByInstanceId": "claimedByInstanceId",
            },
            ExpressionAttributeValues: marshall({
              ":pending": PENDING_STATUS,
              ":instanceId": instanceId,
              ":nowEpochSeconds": nowEpochSeconds,
            }),
            ScanIndexForward: true,
            Limit: limit,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        commands.push(
          ...(result.Items ?? []).map(
            (item) => unmarshall(item) as MeetingControlCommand,
          ),
        );
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (commands.length < limit && exclusiveStartKey);

      return commands.slice(0, limit);
    },
    async claimCommand(input) {
      const command = await repository.getCommand(input.requestId);
      if (!command || !validClaimAuthority(command, input)) return undefined;
      if (
        command.claimId === input.claimId &&
        command.claimedByInstanceId === input.instanceId &&
        command.queueStatus === PENDING_STATUS &&
        (command.claimExpiresAt ?? 0) >= input.nowEpochSeconds
      )
        return command;
      const claimed = {
        ...command,
        claimId: input.claimId,
        claimedByInstanceId: input.instanceId,
        claimExpiresAt: input.claimExpiresAt,
        updatedAt: input.updatedAt,
      };
      try {
        await dynamoDbClient.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: input.claimId,
            TransactItems: [
              ...buildWorkAdmissionChecks(input.authority, tables),
              {
                Put: {
                  TableName: tableName,
                  Item: marshall(claimed, { removeUndefinedValues: true }),
                  ConditionExpression:
                    "#queueStatus = :pending AND expiresAt > :now AND (attribute_not_exists(claimExpiresAt) OR claimExpiresAt < :now)",
                  ExpressionAttributeNames: { "#queueStatus": "queueStatus" },
                  ExpressionAttributeValues: marshall({
                    ":pending": PENDING_STATUS,
                    ":now": input.nowEpochSeconds,
                  }),
                },
              },
            ],
          }),
        );
        return claimed;
      } catch (error) {
        if (classifyDeploymentTransactionError(error) === "stale")
          return undefined;
        throw error;
      }
    },
    async renewCommand(input) {
      try {
        await dynamoDbClient.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: marshall(commandKey(input.requestId)),
            UpdateExpression:
              "SET claimExpiresAt = :expiry, updatedAt = :updated",
            ConditionExpression:
              "#status = :pending AND claimedByInstanceId = :owner AND claimId = :claim AND claimExpiresAt >= :now",
            ExpressionAttributeNames: { "#status": "queueStatus" },
            ExpressionAttributeValues: marshall({
              ":pending": PENDING_STATUS,
              ":owner": input.instanceId,
              ":claim": input.claimId,
              ":now": input.nowEpochSeconds,
              ":expiry": input.claimExpiresAt,
              ":updated": input.updatedAt,
            }),
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
    async completeCommand(input) {
      try {
        await dynamoDbClient.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: marshall(commandKey(input.requestId)),
            UpdateExpression:
              "SET #queueStatus = :completed, #result = :result, #updatedAt = :updatedAt REMOVE #error",
            ConditionExpression:
              "#queueStatus = :pending AND #claimedByInstanceId = :instanceId AND claimId = :claimId AND claimExpiresAt >= :now",
            ExpressionAttributeNames: {
              "#queueStatus": "queueStatus",
              "#result": "result",
              "#updatedAt": "updatedAt",
              "#error": "error",
              "#claimedByInstanceId": "claimedByInstanceId",
            },
            ExpressionAttributeValues: marshall({
              ":pending": PENDING_STATUS,
              ":completed": "completed",
              ":result": input.result,
              ":updatedAt": input.updatedAt,
              ":instanceId": input.instanceId,
              ":claimId": input.claimId,
              ":now": input.nowEpochSeconds,
            }),
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
    async failCommand(input, signal) {
      try {
        signal?.throwIfAborted();
        await dynamoDbClient.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: marshall(commandKey(input.requestId)),
            UpdateExpression:
              "SET #queueStatus = :failed, #error = :error, #updatedAt = :updatedAt REMOVE #result",
            ConditionExpression:
              "#queueStatus = :pending AND #claimedByInstanceId = :instanceId AND claimId = :claimId AND claimExpiresAt >= :now",
            ExpressionAttributeNames: {
              "#queueStatus": "queueStatus",
              "#error": "error",
              "#updatedAt": "updatedAt",
              "#result": "result",
              "#claimedByInstanceId": "claimedByInstanceId",
            },
            ExpressionAttributeValues: marshall({
              ":pending": PENDING_STATUS,
              ":failed": "failed",
              ":error": input.error,
              ":updatedAt": input.updatedAt,
              ":instanceId": input.instanceId,
              ":claimId": input.claimId,
              ":now": input.nowEpochSeconds,
            }),
          }),
          signal ? { abortSignal: signal } : undefined,
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
  };

  return repository;
}
const realRepository = createDynamoMeetingControlCommandRepository(
  dynamoDbClient,
  tableName,
  {
    deploymentControl: `${config.database.tablePrefix ?? ""}DeploymentControlTable`,
    meetingHistory: `${config.database.tablePrefix ?? ""}MeetingHistoryTable`,
    activeMeeting: `${config.database.tablePrefix ?? ""}ActiveMeetingTable`,
  },
);
const memoryCommands = new Map<string, MeetingControlCommand>();

const cloneCommand = (command: MeetingControlCommand): MeetingControlCommand =>
  JSON.parse(JSON.stringify(command)) as MeetingControlCommand;

const memoryRepository: MeetingControlCommandRepository = {
  async renewCommand(input) {
    const command = memoryCommands.get(input.requestId);
    if (
      !command ||
      command.queueStatus !== PENDING_STATUS ||
      command.claimedByInstanceId !== input.instanceId ||
      command.claimId !== input.claimId ||
      (command.claimExpiresAt ?? 0) < input.nowEpochSeconds
    )
      return false;
    command.claimExpiresAt = input.claimExpiresAt;
    command.updatedAt = input.updatedAt;
    return true;
  },
  async writeCommand(command) {
    if (memoryCommands.has(command.requestId)) {
      throw new Error("Meeting control command already exists.");
    }
    memoryCommands.set(command.requestId, cloneCommand(command));
  },
  async getCommand(requestId) {
    const command = memoryCommands.get(requestId);
    return command ? cloneCommand(command) : undefined;
  },
  async listClaimablePendingCommands({ instanceId, nowEpochSeconds, limit }) {
    return Array.from(memoryCommands.values())
      .filter((command) => command.queueStatus === PENDING_STATUS)
      .filter((command) => command.expiresAt > nowEpochSeconds)
      .filter(
        (command) =>
          !command.targetOwnerInstanceId ||
          command.targetOwnerInstanceId === instanceId,
      )
      .filter(
        (command) =>
          !command.claimExpiresAt ||
          command.claimExpiresAt < nowEpochSeconds ||
          command.claimedByInstanceId === instanceId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map(cloneCommand);
  },
  async claimCommand(input) {
    const command = memoryCommands.get(input.requestId);
    if (!command || command.queueStatus !== PENDING_STATUS) return undefined;
    if (!validClaimAuthority(command, input)) return undefined;
    if (
      command.claimId === input.claimId &&
      command.claimedByInstanceId === input.instanceId &&
      (command.claimExpiresAt ?? 0) >= input.nowEpochSeconds
    )
      return cloneCommand(command);
    const store = getMockStore();
    if (
      !mockWorkAdmissionAllowed(
        input.authority,
        store.deploymentControlRecords,
        store.activeMeetingLeases,
      )
    )
      return undefined;
    if (command.expiresAt <= input.nowEpochSeconds) return undefined;
    if (
      command.targetOwnerInstanceId &&
      command.targetOwnerInstanceId !== input.instanceId
    ) {
      return undefined;
    }
    const claimExpired =
      !command.claimExpiresAt || command.claimExpiresAt < input.nowEpochSeconds;
    if (!claimExpired) return undefined;
    command.claimId = input.claimId;
    command.claimedByInstanceId = input.instanceId;
    command.claimExpiresAt = input.claimExpiresAt;
    command.updatedAt = input.updatedAt;
    return cloneCommand(command);
  },
  async completeCommand(input) {
    const command = memoryCommands.get(input.requestId);
    if (
      !command ||
      command.queueStatus !== PENDING_STATUS ||
      command.claimedByInstanceId !== input.instanceId ||
      command.claimId !== input.claimId ||
      (command.claimExpiresAt ?? 0) < input.nowEpochSeconds
    ) {
      return false;
    }
    command.queueStatus = "completed";
    command.result = input.result;
    command.error = undefined;
    command.updatedAt = input.updatedAt;
    return true;
  },
  async failCommand(input) {
    const command = memoryCommands.get(input.requestId);
    if (
      !command ||
      command.queueStatus !== PENDING_STATUS ||
      command.claimedByInstanceId !== input.instanceId ||
      command.claimId !== input.claimId ||
      (command.claimExpiresAt ?? 0) < input.nowEpochSeconds
    ) {
      return false;
    }
    command.queueStatus = "failed";
    command.error = input.error;
    command.result = undefined;
    command.updatedAt = input.updatedAt;
    return true;
  },
};

export const getMeetingControlCommandRepository = () =>
  config.mock.enabled ? memoryRepository : realRepository;

export const resetMeetingControlCommandMemoryRepository = () => {
  memoryCommands.clear();
};
