import {
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
  | ({
      pk: string;
      sk: string;
      recordType: "meeting_export";
    } & NotionMeetingExport);

export type NotionIntegrationRepository = {
  writeConnection: (connection: NotionConnection) => Promise<void>;
  getConnection: (userId: string) => Promise<NotionConnection | undefined>;
  deleteConnection: (userId: string) => Promise<void>;
  writeMeetingExport: (meetingExport: NotionMeetingExport) => Promise<void>;
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
  async getMeetingExport(params) {
    const item = await getItem<NotionIntegrationItem>(meetingExportKey(params));
    return item?.recordType === "meeting_export" ? item : undefined;
  },
};

const memoryConnections = new Map<string, NotionConnection>();
const memoryExports = new Map<string, NotionMeetingExport>();

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
  async writeMeetingExport(meetingExport) {
    memoryExports.set(
      memoryExportKey({
        userId: meetingExport.userId,
        guildId: meetingExport.guildId,
        meetingId: meetingExport.channelId_timestamp,
      }),
      meetingExport,
    );
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
}
