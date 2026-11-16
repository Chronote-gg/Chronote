/** @jest-environment node */
const environment = { ...process.env };
beforeEach(() => {
  jest.resetModules();
  process.env.NODE_ENV = "development";
  process.env.USE_LOCAL_DYNAMODB = "true";
  process.env.MOCK_MODE = "false";
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "unused-global-test-key";
  process.env.AWS_SECRET_ACCESS_KEY = "unused-global-test-secret";
  process.env.ECS_CONTAINER_METADATA_URI_V4 = "";
  process.env.ECS_AGENT_URI = "";
  process.env.AWS_EXECUTION_ENV = "";
});
afterEach(() => {
  process.env = { ...environment };
});

test("actual app factory uses local client credentials and region independently of global AWS configuration", async () => {
  const { config } = await import("../../src/services/configService");
  expect(config.database.useLocalDynamoDB).toBe(true);
  expect(config.mock.enabled).toBe(false);
  const { dynamoDbClient } = await import("../../src/db");
  const endpoint = await dynamoDbClient.config.endpoint?.();
  const credentials = await dynamoDbClient.config.credentials();
  expect(endpoint?.hostname).toBe("localhost");
  expect(await dynamoDbClient.config.region()).toBe("local");
  expect(credentials).toMatchObject({
    accessKeyId: "dummy",
    secretAccessKey: "dummy",
  });
  expect(process.env.AWS_REGION).toBe("us-east-1");
  expect(process.env.AWS_ACCESS_KEY_ID).toBe("unused-global-test-key");
});
