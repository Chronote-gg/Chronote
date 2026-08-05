import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import type {
  McpOAuthAuthorizationCode,
  McpOAuthClient,
  McpOAuthConsent,
  McpOAuthToken,
} from "../types/mcpOAuth";
import type { McpServiceAccountToken } from "../types/mcpServiceAccount";

type McpOAuthItem =
  | ({ pk: string; sk: string; recordType: "client" } & McpOAuthClient)
  | ({
      pk: string;
      sk: string;
      recordType: "authorization_code";
    } & McpOAuthAuthorizationCode)
  | ({ pk: string; sk: string; recordType: "token" } & McpOAuthToken)
  | ({ pk: string; sk: string; recordType: "consent" } & McpOAuthConsent)
  | ({
      pk: string;
      sk: string;
      recordType: "service_account_token";
    } & McpServiceAccountToken);

export type McpOAuthRepository = {
  writeClient: (client: McpOAuthClient) => Promise<void>;
  getClient: (clientId: string) => Promise<McpOAuthClient | undefined>;
  writeAuthorizationCode: (code: McpOAuthAuthorizationCode) => Promise<void>;
  getAuthorizationCode: (
    codeHash: string,
  ) => Promise<McpOAuthAuthorizationCode | undefined>;
  consumeAuthorizationCode: (
    codeHash: string,
  ) => Promise<McpOAuthAuthorizationCode | undefined>;
  deleteAuthorizationCode: (codeHash: string) => Promise<void>;
  writeToken: (token: McpOAuthToken) => Promise<void>;
  getToken: (
    tokenType: McpOAuthToken["tokenType"],
    tokenHash: string,
  ) => Promise<McpOAuthToken | undefined>;
  consumeToken: (
    tokenType: McpOAuthToken["tokenType"],
    tokenHash: string,
  ) => Promise<McpOAuthToken | undefined>;
  deleteToken: (
    tokenType: McpOAuthToken["tokenType"],
    tokenHash: string,
  ) => Promise<void>;
  writeConsent: (consent: McpOAuthConsent) => Promise<void>;
  getConsent: (
    userId: string,
    clientId: string,
  ) => Promise<McpOAuthConsent | undefined>;
  writeServiceAccountToken: (token: McpServiceAccountToken) => Promise<void>;
  getServiceAccountTokenByHash: (
    tokenHash: string,
  ) => Promise<McpServiceAccountToken | undefined>;
  listServiceAccountTokens: (
    guildId: string,
  ) => Promise<McpServiceAccountToken[]>;
  deleteServiceAccountToken: (
    guildId: string,
    tokenId: string,
  ) => Promise<boolean>;
};

const tableName = `${config.database.tablePrefix ?? ""}McpOAuthTable`;

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

const clientKey = (clientId: string) => ({
  pk: `CLIENT#${clientId}`,
  sk: "META",
});
const authorizationCodeKey = (codeHash: string) => ({
  pk: `AUTH_CODE#${codeHash}`,
  sk: "META",
});
const tokenKey = (
  tokenType: McpOAuthToken["tokenType"],
  tokenHash: string,
) => ({
  pk: `${tokenType.toUpperCase()}#${tokenHash}`,
  sk: "META",
});
const consentKey = (userId: string, clientId: string) => ({
  pk: `CONSENT#${userId}`,
  sk: `CLIENT#${clientId}`,
});
// The secret item is keyed by hash so validation is a single point read, and a
// mirror item is keyed by guild so the portal can list tokens without scanning.
const serviceAccountSecretKey = (tokenHash: string) => ({
  pk: `SERVICE_ACCOUNT_TOKEN#${tokenHash}`,
  sk: "META",
});
const serviceAccountGuildKey = (guildId: string, tokenId: string) => ({
  pk: `SERVICE_ACCOUNT_TOKENS#${guildId}`,
  sk: `TOKEN#${tokenId}`,
});

const writeItem = async (item: McpOAuthItem) => {
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

const consumeItem = async <T>(key: { pk: string; sk: string }) => {
  const result = await dynamoDbClient.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: marshall(key),
      ReturnValues: "ALL_OLD",
    }),
  );
  return result.Attributes ? (unmarshall(result.Attributes) as T) : undefined;
};

const realRepository: McpOAuthRepository = {
  writeClient: (client) =>
    writeItem({
      ...clientKey(client.clientId),
      recordType: "client",
      ...client,
    }),
  async getClient(clientId) {
    const item = await getItem<McpOAuthItem>(clientKey(clientId));
    return item?.recordType === "client" ? item : undefined;
  },
  writeAuthorizationCode: (code) =>
    writeItem({
      ...authorizationCodeKey(code.codeHash),
      recordType: "authorization_code",
      ...code,
    }),
  async getAuthorizationCode(codeHash) {
    const item = await getItem<McpOAuthItem>(authorizationCodeKey(codeHash));
    return item?.recordType === "authorization_code" ? item : undefined;
  },
  async consumeAuthorizationCode(codeHash) {
    const item = await consumeItem<McpOAuthItem>(
      authorizationCodeKey(codeHash),
    );
    return item?.recordType === "authorization_code" ? item : undefined;
  },
  deleteAuthorizationCode: (codeHash) =>
    deleteItem(authorizationCodeKey(codeHash)),
  writeToken: (token) =>
    writeItem({
      ...tokenKey(token.tokenType, token.tokenHash),
      recordType: "token",
      ...token,
    }),
  async getToken(tokenType, tokenHash) {
    const item = await getItem<McpOAuthItem>(tokenKey(tokenType, tokenHash));
    return item?.recordType === "token" ? item : undefined;
  },
  async consumeToken(tokenType, tokenHash) {
    const item = await consumeItem<McpOAuthItem>(
      tokenKey(tokenType, tokenHash),
    );
    return item?.recordType === "token" ? item : undefined;
  },
  deleteToken: (tokenType, tokenHash) =>
    deleteItem(tokenKey(tokenType, tokenHash)),
  writeConsent: (consent) =>
    writeItem({
      ...consentKey(consent.userId, consent.clientId),
      recordType: "consent",
      ...consent,
    }),
  async getConsent(userId, clientId) {
    const item = await getItem<McpOAuthItem>(consentKey(userId, clientId));
    return item?.recordType === "consent" ? item : undefined;
  },
  async writeServiceAccountToken(token) {
    const item = {
      recordType: "service_account_token" as const,
      ...token,
    };
    await Promise.all([
      writeItem({ ...serviceAccountSecretKey(token.tokenHash), ...item }),
      writeItem({
        ...serviceAccountGuildKey(token.guildId, token.tokenId),
        ...item,
      }),
    ]);
  },
  async getServiceAccountTokenByHash(tokenHash) {
    const item = await getItem<McpOAuthItem>(
      serviceAccountSecretKey(tokenHash),
    );
    return item?.recordType === "service_account_token" ? item : undefined;
  },
  async listServiceAccountTokens(guildId) {
    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: marshall({
          ":pk": serviceAccountGuildKey(guildId, "").pk,
        }),
      }),
    );
    return (result.Items ?? []).map(
      (item) => unmarshall(item) as McpServiceAccountToken,
    );
  },
  async deleteServiceAccountToken(guildId, tokenId) {
    const item = await consumeItem<McpOAuthItem>(
      serviceAccountGuildKey(guildId, tokenId),
    );
    if (item?.recordType !== "service_account_token") return false;
    await deleteItem(serviceAccountSecretKey(item.tokenHash));
    return true;
  },
};

const memoryClients = new Map<string, McpOAuthClient>();
const memoryCodes = new Map<string, McpOAuthAuthorizationCode>();
const memoryTokens = new Map<string, McpOAuthToken>();
const memoryConsents = new Map<string, McpOAuthConsent>();
const memoryServiceAccountTokens = new Map<string, McpServiceAccountToken>();

const memoryTokenKey = (
  tokenType: McpOAuthToken["tokenType"],
  tokenHash: string,
) => `${tokenType}#${tokenHash}`;
const memoryConsentKey = (userId: string, clientId: string) =>
  `${userId}#${clientId}`;

const memoryRepository: McpOAuthRepository = {
  async writeClient(client) {
    memoryClients.set(client.clientId, client);
  },
  async getClient(clientId) {
    return memoryClients.get(clientId);
  },
  async writeAuthorizationCode(code) {
    memoryCodes.set(code.codeHash, code);
  },
  async getAuthorizationCode(codeHash) {
    return memoryCodes.get(codeHash);
  },
  async consumeAuthorizationCode(codeHash) {
    const code = memoryCodes.get(codeHash);
    memoryCodes.delete(codeHash);
    return code;
  },
  async deleteAuthorizationCode(codeHash) {
    memoryCodes.delete(codeHash);
  },
  async writeToken(token) {
    memoryTokens.set(memoryTokenKey(token.tokenType, token.tokenHash), token);
  },
  async getToken(tokenType, tokenHash) {
    return memoryTokens.get(memoryTokenKey(tokenType, tokenHash));
  },
  async consumeToken(tokenType, tokenHash) {
    const key = memoryTokenKey(tokenType, tokenHash);
    const token = memoryTokens.get(key);
    memoryTokens.delete(key);
    return token;
  },
  async deleteToken(tokenType, tokenHash) {
    memoryTokens.delete(memoryTokenKey(tokenType, tokenHash));
  },
  async writeConsent(consent) {
    memoryConsents.set(
      memoryConsentKey(consent.userId, consent.clientId),
      consent,
    );
  },
  async getConsent(userId, clientId) {
    return memoryConsents.get(memoryConsentKey(userId, clientId));
  },
  async writeServiceAccountToken(token) {
    memoryServiceAccountTokens.set(token.tokenId, token);
  },
  async getServiceAccountTokenByHash(tokenHash) {
    return Array.from(memoryServiceAccountTokens.values()).find(
      (token) => token.tokenHash === tokenHash,
    );
  },
  async listServiceAccountTokens(guildId) {
    return Array.from(memoryServiceAccountTokens.values()).filter(
      (token) => token.guildId === guildId,
    );
  },
  async deleteServiceAccountToken(guildId, tokenId) {
    const token = memoryServiceAccountTokens.get(tokenId);
    if (!token || token.guildId !== guildId) return false;
    memoryServiceAccountTokens.delete(tokenId);
    return true;
  },
};

export const getMcpOAuthRepository = () =>
  config.mock.enabled ? memoryRepository : realRepository;

export const resetMcpOAuthMemoryRepository = () => {
  memoryClients.clear();
  memoryCodes.clear();
  memoryTokens.clear();
  memoryConsents.clear();
  memoryServiceAccountTokens.clear();
};
