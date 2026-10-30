import {
  TransactionConflictException,
  UpdateItemCommand,
  type DynamoDBClient,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as delay } from "node:timers/promises";
import { classifyDeploymentTransactionError } from "./deploymentControlErrors";

/** Checkpoint transactions can briefly reject the heartbeat's conditional update. */
export async function renewActiveMeetingLeaseWrite(
  client: DynamoDBClient,
  input: UpdateItemCommandInput,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      await client.send(
        new UpdateItemCommand({
          ...input,
          ExpressionAttributeValues: {
            ...input.ExpressionAttributeValues,
            ":now": { N: String(Math.floor(Date.now() / 1000)) },
          },
        }),
        { abortSignal: signal },
      );
      signal?.throwIfAborted();
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (classifyDeploymentTransactionError(error) === "stale") return false;
      if (!(error instanceof TransactionConflictException) || attempt >= 2)
        throw error;
      await delay(100 * 2 ** attempt, undefined, { signal });
    }
  }
}
