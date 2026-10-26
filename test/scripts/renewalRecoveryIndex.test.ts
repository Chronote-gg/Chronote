/** @jest-environment node */
import { readFileSync } from "node:fs";
import { runDynamoInitialization } from "./dynamoInitScript.fixture";
import * as dynamo from "@aws-sdk/client-dynamodb";

test.each([false, true])(
  "local initialization preserves existing data and upgrades only a missing index: %s",
  async (exists) => {
    const send = jest.fn(async (command: object) => {
      if (command instanceof dynamo.DescribeTableCommand)
        return {
          Table: {
            GlobalSecondaryIndexes:
              command.input.TableName === "MeetingHistoryTable"
                ? [{ IndexName: "UpdateDeliveryDueIndex" }]
                : exists
                  ? [{ IndexName: "RenewalRecoveryDueIndex" }]
                  : [],
          },
        };
      if (command instanceof dynamo.DescribeTimeToLiveCommand)
        return { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" } };
      return {};
    });
    await runDynamoInitialization(send);
    const updates = send.mock.calls
      .map((call) => call[0])
      .filter((command) => command instanceof dynamo.UpdateTableCommand);
    expect(updates).toHaveLength(exists ? 0 : 1);
    if (!exists)
      expect(updates[0].input).toMatchObject({
        TableName: "GuildSubscriptionTable",
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: "RenewalRecoveryDueIndex",
              Projection: { ProjectionType: "KEYS_ONLY" },
            },
          },
        ],
      });
    expect(
      send.mock.calls.some(
        (call) => call[0] instanceof dynamo.DeleteTableCommand,
      ),
    ).toBe(false);
  },
);

test("Terraform exposes only the exact recovery due index to the task role", () => {
  const source = readFileSync("_infra/main.tf", "utf8");
  expect(source).toContain(
    "${aws_dynamodb_table.guild_subscription_table.arn}/index/RenewalRecoveryDueIndex",
  );
  expect(source).toContain('projection_type = "KEYS_ONLY"');
});

test("the task can describe only the two exact tables for delivery readiness", () => {
  const source = readFileSync("_infra/main.tf", "utf8");
  const policy = source.match(
    /resource "aws_iam_policy" "dynamodb_access_policy" \{([\s\S]*?)\n\}/,
  )?.[1];
  expect(policy).toBeDefined();
  const statements =
    policy?.match(
      /\{\s*(?:Sid\s*=\s*"[^"]*"\s*)?Effect\s*=\s*"Allow"[\s\S]*?Resource\s*=\s*\[[^\]]*\]\s*\}/g,
    ) ?? [];
  const describe = statements.filter((statement) =>
    statement.includes('"dynamodb:DescribeTable"'),
  );
  expect(describe).toHaveLength(1);
  expect(describe[0]).toMatch(
    /Action\s*=\s*\[\s*"dynamodb:DescribeTable"\s*,?\s*\]/,
  );
  expect(describe[0]).toMatch(
    /Resource\s*=\s*\[\s*aws_dynamodb_table\.guild_subscription_table\.arn\s*,\s*aws_dynamodb_table\.meeting_history_table\.arn\s*,?\s*\]/,
  );
});
