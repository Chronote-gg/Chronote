/** @jest-environment node */
import { readFileSync } from "node:fs";
import * as dynamo from "@aws-sdk/client-dynamodb";
import { runDynamoInitialization } from "./dynamoInitScript.fixture";
import { PROCESSING_RETRY_DUE_INDEX } from "../../src/types/meetingProcessingRetry";
import { PROCESSING_RETRY_WORKER_FAILED_LOG } from "../../src/services/processingRetryWorkerService";

const commandsOf = <T>(
  send: jest.Mock,
  type: new (...args: never[]) => T,
): T[] =>
  send.mock.calls
    .map(([command]) => command)
    .filter((command): command is T => command instanceof type);

async function initialize(existingHistoryIndexes: string[]) {
  const send = jest.fn(async (command: object) => {
    if (command instanceof dynamo.DescribeTableCommand)
      return {
        Table: {
          GlobalSecondaryIndexes: (command.input.TableName ===
          "MeetingHistoryTable"
            ? existingHistoryIndexes
            : ["RenewalRecoveryDueIndex"]
          ).map((IndexName) => ({ IndexName, IndexStatus: "ACTIVE" })),
        },
      };
    if (command instanceof dynamo.DescribeTimeToLiveCommand)
      return { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" } };
    return {};
  });
  await runDynamoInitialization(send);
  return send;
}

const retryIndexCreates = (send: jest.Mock) =>
  commandsOf(send, dynamo.UpdateTableCommand).filter(
    (command) =>
      command.input.GlobalSecondaryIndexUpdates?.[0]?.Create?.IndexName ===
      PROCESSING_RETRY_DUE_INDEX,
  );

test("local MeetingHistoryTable declares the sparse retry due index", async () => {
  const send = await initialize([]);
  const history = commandsOf(send, dynamo.CreateTableCommand).find(
    (command) => command.input.TableName === "MeetingHistoryTable",
  );
  expect(history?.input.GlobalSecondaryIndexes).toContainEqual({
    IndexName: PROCESSING_RETRY_DUE_INDEX,
    KeySchema: [
      { AttributeName: "processingRetryQueue", KeyType: "HASH" },
      { AttributeName: "processingRetryDueAt", KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "KEYS_ONLY" },
  });
  const updates = retryIndexCreates(send);
  expect(updates).toHaveLength(1);
  expect(updates[0].input.AttributeDefinitions).toEqual([
    { AttributeName: "processingRetryQueue", AttributeType: "S" },
    { AttributeName: "processingRetryDueAt", AttributeType: "N" },
  ]);
});

test("an existing local retry index is never recreated", async () => {
  const send = await initialize([
    "UpdateDeliveryDueIndex",
    PROCESSING_RETRY_DUE_INDEX,
  ]);
  expect(commandsOf(send, dynamo.UpdateTableCommand)).toHaveLength(0);
});

test("Terraform defines the retry due index on MeetingHistory", () => {
  const history = readFileSync("_infra/main.tf", "utf8").match(
    /resource "aws_dynamodb_table" "meeting_history_table" \{([\s\S]*?)\n\}/,
  )?.[1];
  const index = history?.match(
    /dynamic "global_secondary_index" \{\s*for_each = var\.ENABLE_PROCESSING_RETRY_INDEX \? \[1\] : \[\]\s*content \{([^}]*name\s*=\s*"ProcessingRetryDueIndex"[^}]*)\}/,
  )?.[1];
  expect(index).toMatch(
    new RegExp(`name\\s*=\\s*"${PROCESSING_RETRY_DUE_INDEX}"`),
  );
  expect(index).toMatch(/hash_key\s*=\s*"processingRetryQueue"/);
  expect(index).toMatch(/range_key\s*=\s*"processingRetryDueAt"/);
  expect(index).toMatch(/projection_type\s*=\s*"KEYS_ONLY"/);
  expect(history).toMatch(
    /name\s*=\s*"processingRetryQueue"\s*\n\s*type\s*=\s*"S"/,
  );
  expect(history).toMatch(
    /name\s*=\s*"processingRetryDueAt"\s*\n\s*type\s*=\s*"N"/,
  );
});

test("the worker failure alarm matches the logged line and emails critical alerts", () => {
  const source = readFileSync("_infra/alerts-processing-retry.tf", "utf8");
  const main = readFileSync("_infra/main.tf", "utf8");
  const notifications = readFileSync("_infra/notifications.tf", "utf8");
  expect(source.match(/pattern\s*=\s*"\\"(.*)\\""/)?.[1]).toBe(
    PROCESSING_RETRY_WORKER_FAILED_LOG,
  );
  // Names, not resource references, keep the KMS key policy out of the
  // processing-retry targeted graph.
  expect(source).toContain("log_group_name = local.app_log_group_name");
  expect(main).toContain(
    'app_log_group_name      = "/ecs/${local.name_prefix}-bot"',
  );
  expect(main).toMatch(/name\s*=\s*local\.app_log_group_name/);
  expect(source).toContain(
    'critical_alerts_topic_arn = "arn:aws:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${local.critical_alerts_topic}"',
  );
  expect(source).toMatch(
    /alarm_actions\s*=\s*\[local\.critical_alerts_topic_arn\]/,
  );
  expect(source).toMatch(
    /ok_actions\s*=\s*\[local\.critical_alerts_topic_arn\]/,
  );
  expect(notifications).toContain(
    'critical_alerts_topic  = "${local.name_prefix}-critical-alerts"',
  );
  expect(notifications).toMatch(/name\s*=\s*local\.critical_alerts_topic\n/);
  expect(source).not.toMatch(/aws_cloudwatch_log_group\.|aws_sns_topic\./);
  expect(
    source.match(/count\s*=\s*local\.alerts_enabled \? 1 : 0/g),
  ).toHaveLength(2);
});
