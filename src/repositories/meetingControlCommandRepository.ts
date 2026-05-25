import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import type {
  MeetingControlCommand,
  MeetingControlCommandResult,
} from "../types/meetingControl";

const PENDING_STATUS = "pending";
const STATUS_CREATED_AT_INDEX = "StatusCreatedAtIndex";

export type ClaimMeetingControlCommandInput = {
  requestId: string;
  instanceId: string;
  nowEpochSeconds: number;
  claimExpiresAt: number;
  updatedAt: string;
};

export type CompleteMeetingControlCommandInput = {
  requestId: string;
  instanceId: string;
  updatedAt: string;
  result: MeetingControlCommandResult;
};

export type FailMeetingControlCommandInput = {
  requestId: string;
  instanceId: string;
  updatedAt: string;
  error: string;
};

export type MeetingControlCommandRepository = {
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
  failCommand: (input: FailMeetingControlCommandInput) => Promise<boolean>;
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

const realRepository: MeetingControlCommandRepository = {
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
            "(attribute_not_exists(#targetOwnerInstanceId) OR #targetOwnerInstanceId = :instanceId) AND (attribute_not_exists(#claimExpiresAt) OR #claimExpiresAt < :nowEpochSeconds OR #claimedByInstanceId = :instanceId)",
          ExpressionAttributeNames: {
            "#queueStatus": "queueStatus",
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
    const result = await dynamoDbClient
      .send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: marshall(commandKey(input.requestId)),
          UpdateExpression:
            "SET #claimedByInstanceId = :instanceId, #claimExpiresAt = :claimExpiresAt, #updatedAt = :updatedAt",
          ConditionExpression:
            "#queueStatus = :pending AND (attribute_not_exists(#targetOwnerInstanceId) OR #targetOwnerInstanceId = :instanceId) AND (attribute_not_exists(#claimExpiresAt) OR #claimExpiresAt < :nowEpochSeconds OR #claimedByInstanceId = :instanceId)",
          ExpressionAttributeNames: {
            "#queueStatus": "queueStatus",
            "#targetOwnerInstanceId": "targetOwnerInstanceId",
            "#claimedByInstanceId": "claimedByInstanceId",
            "#claimExpiresAt": "claimExpiresAt",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: marshall({
            ":pending": PENDING_STATUS,
            ":instanceId": input.instanceId,
            ":claimExpiresAt": input.claimExpiresAt,
            ":nowEpochSeconds": input.nowEpochSeconds,
            ":updatedAt": input.updatedAt,
          }),
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((error: unknown) => {
        if (isConditionalFailure(error)) return undefined;
        throw error;
      });
    return result?.Attributes
      ? (unmarshall(result.Attributes) as MeetingControlCommand)
      : undefined;
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
            "#queueStatus = :pending AND #claimedByInstanceId = :instanceId",
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
          }),
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  },
  async failCommand(input) {
    try {
      await dynamoDbClient.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: marshall(commandKey(input.requestId)),
          UpdateExpression:
            "SET #queueStatus = :failed, #error = :error, #updatedAt = :updatedAt REMOVE #result",
          ConditionExpression:
            "#queueStatus = :pending AND #claimedByInstanceId = :instanceId",
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
          }),
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  },
};

const memoryCommands = new Map<string, MeetingControlCommand>();

const cloneCommand = (command: MeetingControlCommand): MeetingControlCommand =>
  JSON.parse(JSON.stringify(command)) as MeetingControlCommand;

const memoryRepository: MeetingControlCommandRepository = {
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
    if (
      command.targetOwnerInstanceId &&
      command.targetOwnerInstanceId !== input.instanceId
    ) {
      return undefined;
    }
    const claimExpired =
      !command.claimExpiresAt || command.claimExpiresAt < input.nowEpochSeconds;
    const ownClaim = command.claimedByInstanceId === input.instanceId;
    if (!claimExpired && !ownClaim) return undefined;
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
      command.claimedByInstanceId !== input.instanceId
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
      command.claimedByInstanceId !== input.instanceId
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
