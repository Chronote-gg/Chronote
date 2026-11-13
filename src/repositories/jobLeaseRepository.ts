import {
  type DynamoDBClient,
  DeleteItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { config } from "../services/configService";
import { classifyDeploymentTransactionError } from "./deploymentControlErrors";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { getMockStore } from "./mockStore";

export const JOBS_PK = "JOBS";

export type JobLeaseRecord = {
  pk: "JOBS";
  sk: `JOB#${string}`;
  recordType: "job_lease";
  owner: string;
  /** Epoch seconds; also the table's TTL attribute. */
  expiresAt: number;
};
export type JobLeaseInput = {
  name: string;
  owner: string;
  now: number;
  ttlSeconds: number;
};
export type JobLeaseRepository = {
  /** True when `owner` now holds the job: it was free, expired, or already this owner's. */
  tryAcquireJobLease(input: JobLeaseInput): Promise<boolean>;
  /** Frees the job when `owner` holds it; otherwise a no-op. */
  releaseJobLease(input: Pick<JobLeaseInput, "name" | "owner">): Promise<void>;
};

const leaseSortKey = (name: string): JobLeaseRecord["sk"] => `JOB#${name}`;
function leaseRecord(input: JobLeaseInput): JobLeaseRecord {
  return {
    pk: JOBS_PK,
    sk: leaseSortKey(input.name),
    recordType: "job_lease",
    owner: input.owner,
    expiresAt: input.now + input.ttlSeconds,
  };
}

export function createDynamoJobLeaseRepository(
  client: DynamoDBClient,
  table: string,
): JobLeaseRepository {
  return {
    async tryAcquireJobLease(input) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: marshall(leaseRecord(input)),
            ConditionExpression:
              "attribute_not_exists(pk) OR expiresAt < :now OR #owner = :owner",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: marshall({
              ":now": input.now,
              ":owner": input.owner,
            }),
          }),
        );
        return true;
      } catch (error) {
        if (classifyDeploymentTransactionError(error) === "stale") return false;
        throw error;
      }
    },
    async releaseJobLease(input) {
      try {
        await client.send(
          new DeleteItemCommand({
            TableName: table,
            Key: marshall({ pk: JOBS_PK, sk: leaseSortKey(input.name) }),
            ConditionExpression: "#owner = :owner",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: marshall({ ":owner": input.owner }),
          }),
        );
      } catch (error) {
        // Another owner's lease, or none at all: nothing of ours to release.
        if (classifyDeploymentTransactionError(error) !== "stale") throw error;
      }
    },
  };
}

export function createMockJobLeaseRepository(
  items: Map<string, JobLeaseRecord>,
): JobLeaseRepository {
  return {
    async tryAcquireJobLease(input) {
      const next = leaseRecord(input);
      const current = items.get(next.sk);
      if (
        current &&
        current.expiresAt >= input.now &&
        current.owner !== input.owner
      )
        return false;
      items.set(next.sk, next);
      return true;
    },
    async releaseJobLease(input) {
      const sk = leaseSortKey(input.name);
      if (items.get(sk)?.owner === input.owner) items.delete(sk);
    },
  };
}

const mockLeases = new WeakMap<object, Map<string, JobLeaseRecord>>();
let nativeRepository: JobLeaseRepository | undefined;
export function getJobLeaseRepository(): JobLeaseRepository {
  if (!config.mock.enabled) {
    nativeRepository ??= createDynamoJobLeaseRepository(
      dynamoDbClient,
      tableName("DeploymentControlTable"),
    );
    return nativeRepository;
  }
  const store = getMockStore();
  let items = mockLeases.get(store);
  if (!items) {
    items = new Map();
    mockLeases.set(store, items);
  }
  return createMockJobLeaseRepository(items);
}
