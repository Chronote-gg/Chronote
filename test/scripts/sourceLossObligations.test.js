/** @jest-environment node */
import { test, expect, jest } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import { inspectObligations } from "../../scripts/deployment/source-loss-obligations.cjs";
test("source metadata pagination retains exact claims and guards without content or settlement", async () => {
  let pages = 0;
  const aws = jest.fn(async (_service, operation, input) => {
    expect(operation).toBe("scan");
    expect(input.ConsistentRead).toBe(true);
    expect(input.ProjectionExpression).not.toMatch(
      /#input|#result|#error|#notes[, ]|#transcript/,
    );
    if (input.TableName.endsWith("MeetingControlCommandTable")) {
      pages++;
      if (!input.ExclusiveStartKey)
        return {
          Items: [
            marshall({
              requestId: "claim-1",
              claimedByInstanceId: "old",
              claimId: "attempt-1",
              queueStatus: "pending",
              input: "PRIVATE",
              result: "PRIVATE",
              error: "PRIVATE",
            }),
          ],
          LastEvaluatedKey: marshall({ requestId: "next" }),
        };
      return {
        Items: [
          marshall({
            requestId: "claim-2",
            targetOwnerInstanceId: "old",
            queueStatus: "pending",
          }),
        ],
      };
    }
    if (input.TableName.endsWith("DeploymentControlTable"))
      return {
        Items: [
          marshall({
            pk: "VOICE#guild",
            sk: "STATE",
            ownerInstanceId: "old",
            meetingId: "held",
            state: "uncertain",
            executionVersion: 2,
          }),
        ],
      };
    return { Items: [] };
  });
  const result = await inspectObligations({
    aws,
    tablePrefix: "fixture-",
    source: { instanceId: "old" },
  });
  expect(pages).toBe(2);
  expect(result.counts.MeetingControlCommandTable).toBe(2);
  expect(result.records.DeploymentControlTable[0]).toMatchObject({
    state: "uncertain",
    executionVersion: 2,
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(result.settlement).toBeUndefined();
});
test("incomplete pagination or denied reads never produce an empty settled audit", async () => {
  await expect(
    inspectObligations({
      aws: async () => ({
        Items: [],
        LastEvaluatedKey: marshall({ pk: "repeat" }),
      }),
      tablePrefix: "fixture-",
      source: { instanceId: "old" },
    }),
  ).rejects.toThrow("pagination incomplete");
  await expect(
    inspectObligations({
      aws: async () => {
        throw new Error("denied");
      },
      tablePrefix: "fixture-",
      source: { instanceId: "old" },
    }),
  ).rejects.toThrow("denied");
});
