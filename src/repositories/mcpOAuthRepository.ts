import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import type {
  McpOAuthAuthorizationCode,
  McpOAuthClient,
  McpOAuthConsent,
  McpOAuthToken,
} from "../types/mcpOAuth";

type McpOAuthItem =
  | ({ pk: string; sk: string; recordType: "client" } & McpOAuthClient)
  | ({
      pk: string;
      sk: string;
      recordType: "authorization_code";
    } & McpOAuthAuthorizationCode)
  | ({ pk: string; sk: string; recordType: "token" } & McpOAuthToken)
  | ({ pk: string; sk: string; recordType: "consent" } & McpOAuthConsent);

export type McpOAuthRepository = {
  writeClient: (client: McpOAuthClient) => Promise<void>;
  getClient: (clientId: string) => Promise<McpOAuthClient | undefined>;
  writeAuthorizationCode: (code: McpOAuthAuthorizationCode) => Promise<void>;
  getAuthorizationCode: (
    codeHash: string,
  ) => Promise<McpOAuthAuthorizationCode | undefined>;
  deleteAuthorizationCode: (codeHash: string) => Promise<void>;
  writeToken: (token: McpOAuthToken) => Promise<void>;
  getToken: (
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
};

const memoryClients = new Map<string, McpOAuthClient>();
const memoryCodes = new Map<string, McpOAuthAuthorizationCode>();
const memoryTokens = new Map<string, McpOAuthToken>();
const memoryConsents = new Map<string, McpOAuthConsent>();

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
  async deleteAuthorizationCode(codeHash) {
    memoryCodes.delete(codeHash);
  },
  async writeToken(token) {
    memoryTokens.set(memoryTokenKey(token.tokenType, token.tokenHash), token);
  },
  async getToken(tokenType, tokenHash) {
    return memoryTokens.get(memoryTokenKey(tokenType, tokenHash));
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
};

export const getMcpOAuthRepository = () =>
  config.mock.enabled ? memoryRepository : realRepository;

export const resetMcpOAuthMemoryRepository = () => {
  memoryClients.clear();
  memoryCodes.clear();
  memoryTokens.clear();
  memoryConsents.clear();
};
