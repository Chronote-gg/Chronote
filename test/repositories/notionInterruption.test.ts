/** @jest-environment node */
import { getNotionIntegrationRepository } from "../../src/repositories/notionIntegrationRepository";
const mockSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({
    send: (...args: unknown[]) => mockSend(...args),
  })),
}));
jest.mock("../../src/services/configService", () => ({
  config: {
    mock: { enabled: false },
    database: { tablePrefix: "synthetic-r3-", useLocalDynamoDB: false },
    storage: { awsRegion: "us-east-1" },
  },
}));
test("an issued automatic export reservation passes its signal to the SDK and retains its actual request", async () => {
  let complete!: () => void;
  mockSend.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        complete = done;
      }),
  );
  const controller = new AbortController();
  let settled = false;
  const operation = getNotionIntegrationRepository()
    .reserveAutomationMeetingExport(
      { guildId: "synthetic", meetingId: "synthetic" },
      controller.signal,
    )
    .then(() => {
      settled = true;
    });
  expect(mockSend.mock.calls[0][1]?.abortSignal).toBe(controller.signal);
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  complete();
  await operation;
  expect(settled).toBe(true);
});
