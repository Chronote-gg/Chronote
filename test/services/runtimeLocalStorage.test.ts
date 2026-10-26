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
  const { getDeploymentControlRepository } = await import("../../src/db");
  expect(await getDeploymentControlRepository().supportsLocalBootstrap()).toBe(
    true,
  );
  expect(process.env.AWS_REGION).toBe("us-east-1");
  expect(process.env.AWS_ACCESS_KEY_ID).toBe("unused-global-test-key");
});
test.each(["remote", "ecs"])(
  "actual app factory cannot grant local capability for %s",
  async (mode) => {
    if (mode === "remote") process.env.USE_LOCAL_DYNAMODB = "false";
    else process.env.AWS_EXECUTION_ENV = "AWS_ECS_FARGATE";
    const { getDeploymentControlRepository } = await import("../../src/db");
    expect(
      await getDeploymentControlRepository().supportsLocalBootstrap(),
    ).toBe(false);
  },
);
