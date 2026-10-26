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
  NotionAutomationConfig,
  NotionAutomationMeetingExport,
  NotionConnection,
  NotionMeetingExport,
} from "../types/notionIntegration";

type NotionIntegrationItem =
  | ({ pk: string; sk: string; recordType: "connection" } & NotionConnection)
  | ({
      pk: string;
      sk: string;
      recordType: "automation_config";
    } & NotionAutomationConfig)
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
    } & NotionMeetingExport)
  | {
      pk: string;
      sk: string;
      recordType: "automation_export_reservation";
      guildId: string;
      channelId_timestamp: string;
      createdAt: string;
    }
  | ({
      pk: string;
      sk: string;
      recordType: "automation_export";
    } & NotionAutomationMeetingExport);

export type NotionIntegrationRepository = {
  writeConnection: (
    connection: NotionConnection,
    signal?: AbortSignal,
  ) => Promise<void>;
  getConnection: (
    userId: string,
    signal?: AbortSignal,
  ) => Promise<NotionConnection | undefined>;
  deleteConnection: (userId: string) => Promise<void>;
  writeAutomationConfig: (
    config: NotionAutomationConfig,
    signal?: AbortSignal,
  ) => Promise<void>;
  getAutomationConfig: (
    guildId: string,
    signal?: AbortSignal,
  ) => Promise<NotionAutomationConfig | undefined>;
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
  reserveAutomationMeetingExport: (
    params: {
      guildId: string;
      meetingId: string;
    },
    signal?: AbortSignal,
  ) => Promise<boolean>;
  writeAutomationMeetingExport: (
    meetingExport: NotionAutomationMeetingExport,
    signal?: AbortSignal,
  ) => Promise<void>;
  deleteAutomationMeetingExport: (params: {
    guildId: string;
    meetingId: string;
  }) => Promise<void>;
  getAutomationMeetingExport: (
    params: {
      guildId: string;
      meetingId: string;
    },
    signal?: AbortSignal,
  ) => Promise<NotionAutomationMeetingExport | undefined>;
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

const automationConfigKey = (guildId: string) => ({
  pk: `GUILD#${guildId}`,
  sk: "AUTOMATION#NOTION",
});

const automationMeetingExportKey = (params: {
  guildId: string;
  meetingId: string;
}) => ({
  pk: `GUILD#${params.guildId}`,
  sk: `EXPORT#${params.meetingId}`,
});

const writeItem = async (item: NotionIntegrationItem, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  await dynamoDbClient.send(
    new PutItemCommand({
      TableName: tableName,
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
    { abortSignal: signal },
  );
};

const reserveItem = async (
  item: NotionIntegrationItem,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  try {
    await dynamoDbClient.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
      { abortSignal: signal },
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
};

const getItem = async <T>(
  key: { pk: string; sk: string },
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
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
  writeConnection: (connection, signal) =>
    writeItem(
      {
        ...connectionKey(connection.userId),
        recordType: "connection",
        ...connection,
      },
      signal,
    ),
  async getConnection(userId, signal) {
    const item = await getItem<NotionIntegrationItem>(
      connectionKey(userId),
      signal,
    );
    return item?.recordType === "connection" ? item : undefined;
  },
  deleteConnection: (userId) => deleteItem(connectionKey(userId)),
  writeAutomationConfig: (automationConfig, signal) =>
    writeItem(
      {
        ...automationConfigKey(automationConfig.guildId),
        recordType: "automation_config",
        ...automationConfig,
      },
      signal,
    ),
  async getAutomationConfig(guildId, signal) {
    const item = await getItem<NotionIntegrationItem>(
      automationConfigKey(guildId),
      signal,
    );
    return item?.recordType === "automation_config" ? item : undefined;
  },
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
  reserveAutomationMeetingExport: (params, signal) =>
    reserveItem(
      {
        ...automationMeetingExportKey(params),
        recordType: "automation_export_reservation",
        guildId: params.guildId,
        channelId_timestamp: params.meetingId,
        createdAt: new Date().toISOString(),
      },
      signal,
    ),
  writeAutomationMeetingExport: (meetingExport, signal) =>
    writeItem(
      {
        ...automationMeetingExportKey({
          guildId: meetingExport.guildId,
          meetingId: meetingExport.channelId_timestamp,
        }),
        recordType: "automation_export",
        ...meetingExport,
      },
      signal,
    ),
  deleteAutomationMeetingExport: (params) =>
    deleteItem(automationMeetingExportKey(params)),
  async getAutomationMeetingExport(params, signal) {
    const item = await getItem<NotionIntegrationItem>(
      automationMeetingExportKey(params),
      signal,
    );
    return item?.recordType === "automation_export" ? item : undefined;
  },
};

const memoryConnections = new Map<string, NotionConnection>();
const memoryExports = new Map<string, NotionMeetingExport>();
const memoryExportReservations = new Set<string>();
const memoryAutomationConfigs = new Map<string, NotionAutomationConfig>();
const memoryAutomationExports = new Map<
  string,
  NotionAutomationMeetingExport
>();
const memoryAutomationExportReservations = new Set<string>();

const memoryExportKey = (params: {
  userId: string;
  guildId: string;
  meetingId: string;
}) => `${params.userId}#${params.guildId}#${params.meetingId}`;

const memoryAutomationExportKey = (params: {
  guildId: string;
  meetingId: string;
}) => `${params.guildId}#${params.meetingId}`;

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
  async writeAutomationConfig(automationConfig) {
    memoryAutomationConfigs.set(automationConfig.guildId, automationConfig);
  },
  async getAutomationConfig(guildId) {
    return memoryAutomationConfigs.get(guildId);
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
  async reserveAutomationMeetingExport(params) {
    const key = memoryAutomationExportKey(params);
    if (
      memoryAutomationExports.has(key) ||
      memoryAutomationExportReservations.has(key)
    ) {
      return false;
    }
    memoryAutomationExportReservations.add(key);
    return true;
  },
  async writeAutomationMeetingExport(meetingExport) {
    const key = memoryAutomationExportKey({
      guildId: meetingExport.guildId,
      meetingId: meetingExport.channelId_timestamp,
    });
    memoryAutomationExports.set(key, meetingExport);
    memoryAutomationExportReservations.delete(key);
  },
  async deleteAutomationMeetingExport(params) {
    const key = memoryAutomationExportKey(params);
    memoryAutomationExports.delete(key);
    memoryAutomationExportReservations.delete(key);
  },
  async getAutomationMeetingExport(params) {
    return memoryAutomationExports.get(memoryAutomationExportKey(params));
  },
};

export function getNotionIntegrationRepository(): NotionIntegrationRepository {
  return config.mock.enabled ? memoryRepository : realRepository;
}

export function resetNotionIntegrationMemoryRepository() {
  memoryConnections.clear();
  memoryExports.clear();
  memoryExportReservations.clear();
  memoryAutomationConfigs.clear();
  memoryAutomationExports.clear();
  memoryAutomationExportReservations.clear();
}
