export function createLoopbackDynamoMock() {
  const sdk = jest.requireActual("@aws-sdk/client-dynamodb");
  class LoopbackDynamoClient extends sdk.DynamoDBClient {
    constructor() {
      super({
        endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
        region: "local",
        credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
        maxAttempts: 1,
      });
    }
  }
  return { ...sdk, DynamoDBClient: LoopbackDynamoClient };
}
