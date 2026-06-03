import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import type {
  DesktopAuthorizationCode,
  DesktopAuthToken,
} from "../types/desktopAuth";

type DesktopAuthItem =
  | ({
      pk: string;
      sk: string;
      recordType: "desktop_authorization_code";
    } & DesktopAuthorizationCode)
  | ({
      pk: string;
      sk: string;
      recordType: "desktop_token";
    } & DesktopAuthToken);

export type DesktopAuthRepository = {
  writeAuthorizationCode: (code: DesktopAuthorizationCode) => Promise<void>;
  consumeAuthorizationCode: (
    codeHash: string,
  ) => Promise<DesktopAuthorizationCode | undefined>;
  writeToken: (token: DesktopAuthToken) => Promise<void>;
  getToken: (
    tokenType: DesktopAuthToken["tokenType"],
    tokenHash: string,
  ) => Promise<DesktopAuthToken | undefined>;
  consumeToken: (
    tokenType: DesktopAuthToken["tokenType"],
    tokenHash: string,
  ) => Promise<DesktopAuthToken | undefined>;
  deleteToken: (
    tokenType: DesktopAuthToken["tokenType"],
    tokenHash: string,
  ) => Promise<void>;
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

const authorizationCodeKey = (codeHash: string) => ({
  pk: `DESKTOP_AUTH_CODE#${codeHash}`,
  sk: "META",
});

const tokenKey = (
  tokenType: DesktopAuthToken["tokenType"],
  tokenHash: string,
) => ({
  pk: `DESKTOP_${tokenType.toUpperCase()}#${tokenHash}`,
  sk: "META",
});

const writeItem = async (item: DesktopAuthItem) => {
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

const deleteItem = async (key: { pk: string; sk: string }) => {
  await dynamoDbClient.send(
    new DeleteItemCommand({ TableName: tableName, Key: marshall(key) }),
  );
};

const realRepository: DesktopAuthRepository = {
  writeAuthorizationCode: (code) =>
    writeItem({
      ...authorizationCodeKey(code.codeHash),
      recordType: "desktop_authorization_code",
      ...code,
    }),
  async consumeAuthorizationCode(codeHash) {
    const item = await consumeItem<DesktopAuthItem>(
      authorizationCodeKey(codeHash),
    );
    return item?.recordType === "desktop_authorization_code" ? item : undefined;
  },
  writeToken: (token) =>
    writeItem({
      ...tokenKey(token.tokenType, token.tokenHash),
      recordType: "desktop_token",
      ...token,
    }),
  async getToken(tokenType, tokenHash) {
    const item = await getItem<DesktopAuthItem>(tokenKey(tokenType, tokenHash));
    return item?.recordType === "desktop_token" ? item : undefined;
  },
  async consumeToken(tokenType, tokenHash) {
    const item = await consumeItem<DesktopAuthItem>(
      tokenKey(tokenType, tokenHash),
    );
    return item?.recordType === "desktop_token" ? item : undefined;
  },
  deleteToken: (tokenType, tokenHash) =>
    deleteItem(tokenKey(tokenType, tokenHash)),
};

const memoryCodes = new Map<string, DesktopAuthorizationCode>();
const memoryTokens = new Map<string, DesktopAuthToken>();

const memoryTokenKey = (
  tokenType: DesktopAuthToken["tokenType"],
  tokenHash: string,
) => `${tokenType}#${tokenHash}`;

const memoryRepository: DesktopAuthRepository = {
  async writeAuthorizationCode(code) {
    memoryCodes.set(code.codeHash, code);
  },
  async consumeAuthorizationCode(codeHash) {
    const code = memoryCodes.get(codeHash);
    memoryCodes.delete(codeHash);
    return code;
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
};

export const getDesktopAuthRepository = () =>
  config.mock.enabled ? memoryRepository : realRepository;

export const resetDesktopAuthMemoryRepository = () => {
  memoryCodes.clear();
  memoryTokens.clear();
};
