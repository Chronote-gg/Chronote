/** @jest-environment node */
import { readFileSync } from "node:fs";
import { runDynamoInitialization } from "./dynamoInitScript.fixture";
import * as dynamo from "@aws-sdk/client-dynamodb";
import { MEETING_UPDATE_DELIVERY_DUE_INDEX } from "../../src/types/meetingUpdateDelivery";
import { INDEX } from "../../scripts/deployment/production-index-preflight.cjs";

test("introduction preflight and runtime require the same delivery index", () => {
  expect(INDEX).toBe(MEETING_UPDATE_DELIVERY_DUE_INDEX);
});

async function initialize(exists: boolean, status = "ACTIVE", fail = false) {
  const send = jest.fn(async (command: object) => {
    if (command instanceof dynamo.DescribeTableCommand) {
      if (fail && command.input.TableName === "MeetingHistoryTable")
        throw Error("describe unavailable");
      return {
        Table: {
          GlobalSecondaryIndexes:
            command.input.TableName === "MeetingHistoryTable"
              ? exists
                ? [{ IndexName: "UpdateDeliveryDueIndex", IndexStatus: status }]
                : []
              : [
                  {
                    IndexName: "RenewalRecoveryDueIndex",
                    IndexStatus: "ACTIVE",
                  },
                ],
        },
      };
    }
    if (command instanceof dynamo.DescribeTimeToLiveCommand)
      return { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" } };
    return {};
  });
  const promise = runDynamoInitialization(send);
  return { send, promise };
}
/** Other MeetingHistory indexes have their own tests; these assert only the delivery index. */
const deliveryIndexCreates = (send: jest.Mock) =>
  send.mock.calls
    .map(([c]) => c)
    .filter(
      (c) =>
        c instanceof dynamo.UpdateTableCommand &&
        c.input.GlobalSecondaryIndexUpdates?.[0]?.Create?.IndexName ===
          "UpdateDeliveryDueIndex",
    );
test.each([false, true])(
  "local initialization preserves data and only creates missing meeting index: %s",
  async (exists) => {
    const { send, promise } = await initialize(exists);
    await promise;
    const creates = send.mock.calls
      .map(([c]) => c)
      .filter((c) => c instanceof dynamo.CreateTableCommand);
    const history = creates.find(
      (c) => c.input.TableName === "MeetingHistoryTable",
    );
    expect(history?.input.GlobalSecondaryIndexes).toContainEqual(
      expect.objectContaining({
        IndexName: "UpdateDeliveryDueIndex",
        KeySchema: [
          { AttributeName: "updateDeliveryQueue", KeyType: "HASH" },
          { AttributeName: "updateDeliveryDueAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "KEYS_ONLY" },
      }),
    );
    const updates = deliveryIndexCreates(send);
    expect(updates).toHaveLength(exists ? 0 : 1);
    if (!exists)
      expect(updates[0].input).toMatchObject({
        TableName: "MeetingHistoryTable",
        AttributeDefinitions: [
          { AttributeName: "updateDeliveryQueue", AttributeType: "S" },
          { AttributeName: "updateDeliveryDueAt", AttributeType: "N" },
        ],
      });
    expect(
      send.mock.calls.some(([c]) => c instanceof dynamo.DeleteTableCommand),
    ).toBe(false);
  },
);
test("an in-progress local index is never recreated", async () => {
  const { send, promise } = await initialize(true, "CREATING");
  await promise;
  expect(deliveryIndexCreates(send)).toHaveLength(0);
});
test("missing-index describe errors propagate instead of reporting readiness", async () => {
  const { promise } = await initialize(false, "ACTIVE", true);
  await expect(promise).rejects.toThrow("describe unavailable");
});
test("Terraform defines the exact sparse index without streams or expanded query/scan authority", () => {
  const source = readFileSync("_infra/main.tf", "utf8");
  const history = source.match(
    /resource "aws_dynamodb_table" "meeting_history_table" \{([\s\S]*?)\n\}/,
  )?.[1];
  expect(history).toMatch(/name\s*=\s*"UpdateDeliveryDueIndex"/);
  expect(history).toMatch(/hash_key\s*=\s*"updateDeliveryQueue"/);
  expect(history).toMatch(/range_key\s*=\s*"updateDeliveryDueAt"/);
  expect(history).toMatch(/projection_type\s*=\s*"KEYS_ONLY"/);
  expect(history).toContain('"GuildTimestampIndex"');
  expect(history).not.toMatch(/stream_enabled/);
  const statement = source.match(
    /Sid\s*=\s*"DescribeSubscriptionReadiness"([\s\S]*?)\n\s*\}/,
  )?.[1];
  expect(statement).toContain("aws_dynamodb_table.meeting_history_table.arn");
  expect(statement).not.toContain("*");
});
