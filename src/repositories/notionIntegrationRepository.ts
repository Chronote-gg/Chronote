import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import type {
  NotionConnection,
  NotionMeetingExport,
} from "../types/notionIntegration";

type NotionIntegrationItem =
  | ({ pk: string; sk: string; recordType: "connection" } & NotionConnection)
  | {
      pk: string;
      sk: string;
      recordType: "meeting_export_reservation";
      userId: string;
      guildId: string;
      channelId_timestamp: string;
      createdAt: string;
    }
  | ({
      pk: string;
      sk: string;
      recordType: "meeting_export";
    } & NotionMeetingExport);

export type NotionIntegrationRepository = {
  writeConnection: (connection: NotionConnection) => Promise<void>;
  getConnection: (userId: string) => Promise<NotionConnection | undefined>;
  deleteConnection: (userId: string) => Promise<void>;
  reserveMeetingExport: (params: {
    userId: string;
    guildId: string;
    meetingId: string;
  }) => Promise<boolean>;
  writeMeetingExport: (meetingExport: NotionMeetingExport) => Promise<void>;
  deleteMeetingExport: (params: {
    userId: string;
    guildId: string;
    meetingId: string;
  }) => Promise<void>;
  getMeetingExport: (params: {
    userId: string;
    guildId: string;
    meetingId: string;
  }) => Promise<NotionMeetingExport | undefined>;
};

const tableName = `${config.database.tablePrefix ?? ""}NotionIntegrationTable`;

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

const connectionKey = (userId: string) => ({
  pk: `USER#${userId}`,
  sk: "CONNECTION#NOTION",
});

const meetingExportKey = (params: {
  userId: string;
  guildId: string;
  meetingId: string;
}) => ({
  pk: `USER#${params.userId}`,
  sk: `EXPORT#${params.guildId}#${params.meetingId}`,
});

const writeItem = async (item: NotionIntegrationItem) => {
  await dynamoDbClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
};

const reserveItem = async (item: NotionIntegrationItem) => {
  try {
    await dynamoDbClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
};

const getItem = async <T>(key: { pk: string; sk: string }) => {
  const result = await dynamoDbClient.send(
    new GetItemCommand({ TableName: tableName, Key: marshall(key) }),
  );
  return result.Item ? (unmarshall(result.Item) as T) : undefined;
};

const deleteItem = async (key: { pk: string; sk: string }) => {
  await dynamoDbClient.send(
    new DeleteItemCommand({ TableName: tableName, Key: marshall(key) }),
  );
};

const realRepository: NotionIntegrationRepository = {
  writeConnection: (connection) =>
    writeItem({
      ...connectionKey(connection.userId),
      recordType: "connection",
      ...connection,
    }),
  async getConnection(userId) {
    const item = await getItem<NotionIntegrationItem>(connectionKey(userId));
    return item?.recordType === "connection" ? item : undefined;
  },
  deleteConnection: (userId) => deleteItem(connectionKey(userId)),
  reserveMeetingExport: (params) =>
    reserveItem({
      ...meetingExportKey(params),
      recordType: "meeting_export_reservation",
      userId: params.userId,
      guildId: params.guildId,
      channelId_timestamp: params.meetingId,
      createdAt: new Date().toISOString(),
    }),
  writeMeetingExport: (meetingExport) =>
    writeItem({
      ...meetingExportKey({
        userId: meetingExport.userId,
        guildId: meetingExport.guildId,
        meetingId: meetingExport.channelId_timestamp,
      }),
      recordType: "meeting_export",
      ...meetingExport,
    }),
  deleteMeetingExport: (params) => deleteItem(meetingExportKey(params)),
  async getMeetingExport(params) {
    const item = await getItem<NotionIntegrationItem>(meetingExportKey(params));
    return item?.recordType === "meeting_export" ? item : undefined;
  },
};

const memoryConnections = new Map<string, NotionConnection>();
const memoryExports = new Map<string, NotionMeetingExport>();
const memoryExportReservations = new Set<string>();

const memoryExportKey = (params: {
  userId: string;
  guildId: string;
  meetingId: string;
}) => `${params.userId}#${params.guildId}#${params.meetingId}`;

const memoryRepository: NotionIntegrationRepository = {
  async writeConnection(connection) {
    memoryConnections.set(connection.userId, connection);
  },
  async getConnection(userId) {
    return memoryConnections.get(userId);
  },
  async deleteConnection(userId) {
    memoryConnections.delete(userId);
  },
  async reserveMeetingExport(params) {
    const key = memoryExportKey(params);
    if (memoryExports.has(key) || memoryExportReservations.has(key)) {
      return false;
    }
    memoryExportReservations.add(key);
    return true;
  },
  async writeMeetingExport(meetingExport) {
    const key = memoryExportKey({
      userId: meetingExport.userId,
      guildId: meetingExport.guildId,
      meetingId: meetingExport.channelId_timestamp,
    });
    memoryExports.set(key, meetingExport);
    memoryExportReservations.delete(key);
  },
  async deleteMeetingExport(params) {
    const key = memoryExportKey(params);
    memoryExports.delete(key);
    memoryExportReservations.delete(key);
  },
  async getMeetingExport(params) {
    return memoryExports.get(memoryExportKey(params));
  },
};

export function getNotionIntegrationRepository(): NotionIntegrationRepository {
  return config.mock.enabled ? memoryRepository : realRepository;
}

export function resetNotionIntegrationMemoryRepository() {
  memoryConnections.clear();
  memoryExports.clear();
  memoryExportReservations.clear();
}
