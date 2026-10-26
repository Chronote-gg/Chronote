/** @jest-environment node */
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { readDynamoIndexStatus } from "../../src/repositories/dynamoIndexStatus";
test("configured table and exact index determine live readiness", async () => {
  let denied = false;
  const client = new DynamoDBClient({ region: "local" }),
    send = jest.spyOn(client, "send").mockImplementation(async () => {
      if (denied) throw Error("describe denied");
      return {
        Table: {
          GlobalSecondaryIndexes: [
            { IndexName: "GuildTimestampIndex", IndexStatus: "ACTIVE" },
            { IndexName: "UpdateDeliveryDueIndex", IndexStatus: "CREATING" },
          ],
        },
      };
    });
  expect(
    await readDynamoIndexStatus(client, {
      mock: false,
      tableName: "synthetic-MeetingHistoryTable",
      indexName: "UpdateDeliveryDueIndex",
    }),
  ).toBe("CREATING");
  expect(send.mock.calls[0][0]).toBeInstanceOf(DescribeTableCommand);
  expect(send.mock.calls[0][0].input).toEqual({
    TableName: "synthetic-MeetingHistoryTable",
  });
  denied = true;
  await expect(
    readDynamoIndexStatus(client, {
      mock: false,
      tableName: "synthetic-MeetingHistoryTable",
      indexName: "UpdateDeliveryDueIndex",
    }),
  ).rejects.toThrow("describe denied");
  client.destroy();
});
test("explicit mock mode needs no live dependency", async () => {
  const client = new DynamoDBClient({ region: "local" }),
    send = jest.spyOn(client, "send");
  expect(
    await readDynamoIndexStatus(client, {
      mock: true,
      tableName: "synthetic",
      indexName: "UpdateDeliveryDueIndex",
    }),
  ).toBe("ACTIVE");
  expect(send).not.toHaveBeenCalled();
  client.destroy();
});
