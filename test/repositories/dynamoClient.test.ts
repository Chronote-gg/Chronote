/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { createServer, type Server, type Socket } from "node:net";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { dynamoRequestHandler } from "../../src/repositories/dynamoClient";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";

test("the shared client bounds connection and request time from LIFECYCLE", () => {
  const constructed: unknown[] = [];
  jest.isolateModules(() => {
    jest.doMock("@aws-sdk/client-dynamodb", () => ({
      DynamoDBClient: jest.fn((options: unknown) => constructed.push(options)),
    }));
    jest.requireActual("../../src/repositories/dynamoClient");
  });
  jest.dontMock("@aws-sdk/client-dynamodb");
  expect(constructed).toEqual([
    expect.objectContaining({
      requestHandler: {
        connectionTimeout: LIFECYCLE.dynamoConnectionTimeoutMs,
        requestTimeout: LIFECYCLE.dynamoRequestTimeoutMs,
        throwOnRequestTimeout: true,
      },
    }),
  ]);
});

test("the meeting control command client, which workers claim through, has the same bound", () => {
  const constructed: unknown[] = [];
  jest.isolateModules(() => {
    jest.doMock("@aws-sdk/client-dynamodb", () => ({
      ...jest.requireActual("@aws-sdk/client-dynamodb"),
      DynamoDBClient: jest.fn((options: unknown) => constructed.push(options)),
    }));
    jest.requireActual(
      "../../src/repositories/meetingControlCommandRepository",
    );
  });
  jest.dontMock("@aws-sdk/client-dynamodb");
  expect(constructed).not.toEqual([]);
  for (const options of constructed)
    expect(options).toMatchObject({ requestHandler: dynamoRequestHandler() });
});

describe("a server that never answers", () => {
  let server: Server;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a call rejects as a retryable timeout within the bound instead of hanging", async () => {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("synthetic server has no port");
    const synthetic = { connectionTimeoutMs: 200, requestTimeoutMs: 100 };
    const attempts = 2;
    const client = new DynamoDBClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: attempts,
      requestHandler: dynamoRequestHandler(synthetic),
    });
    const started = Date.now();
    try {
      await expect(
        client.send(
          new GetItemCommand({
            TableName: "synthetic-table",
            Key: { id: { S: "synthetic-key" } },
          }),
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      client.destroy();
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    // The SDK classifies TimeoutError as transient, so it spends its attempts.
    expect(sockets.length).toBeGreaterThanOrEqual(attempts);
  });
});
