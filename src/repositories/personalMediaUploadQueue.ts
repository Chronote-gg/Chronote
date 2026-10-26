import {
  DynamoDBClient,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import type { DeploymentControlRepository } from "./deploymentControlRepository";
import type { PersonalMediaUploadRepository } from "./personalMediaUploadRepository";
import { getPausedDesktopDraft } from "./pausedDesktopDraft";

export async function listUnpausedPersonalMediaUploadJobs(
  client: DynamoDBClient,
  tables: {
    uploadTable: string;
    statusIndex: string;
    control: Pick<DeploymentControlRepository, "getRecord">;
  },
  options: Parameters<PersonalMediaUploadRepository["listClaimable"]>[0],
): Promise<PersonalMediaUploadJobRecord[]> {
  const jobs: PersonalMediaUploadJobRecord[] = [];
  const statuses: PersonalMediaUploadJobRecord["status"][] = [
    "queued",
    "processing",
  ];

  for (const status of statuses) {
    if (jobs.length >= options.limit) break;
    await appendUnpausedJobsForStatus(client, tables, options, status, jobs);
  }

  return jobs.slice(0, options.limit);
}

type QueueTables = Parameters<typeof listUnpausedPersonalMediaUploadJobs>[1];
type QueueOptions = Parameters<
  PersonalMediaUploadRepository["listClaimable"]
>[0];

function statusQuery(
  tables: QueueTables,
  options: QueueOptions,
  status: PersonalMediaUploadJobRecord["status"],
): QueryCommandInput {
  const isProcessing = status === "processing";
  const filterExpression = isProcessing
    ? "(attribute_not_exists(#claimExpiresAt) OR #claimExpiresAt < :nowEpochSeconds OR #processingOwnerInstanceId = :instanceId) AND (attribute_not_exists(#attempts) OR #attempts < :maxAttempts)"
    : "(attribute_not_exists(#claimExpiresAt) OR #claimExpiresAt < :nowEpochSeconds) AND (attribute_not_exists(#attempts) OR #attempts < :maxAttempts)";
  const expressionAttributeNames = {
    "#status": "status",
    "#claimExpiresAt": "claimExpiresAt",
    "#attempts": "attempts",
    ...(isProcessing
      ? { "#processingOwnerInstanceId": "processingOwnerInstanceId" }
      : {}),
  };
  const expressionAttributeValues = {
    ":status": status,
    ":nowEpochSeconds": options.nowEpochSeconds,
    ":maxAttempts": options.maxAttempts,
    ...(isProcessing ? { ":instanceId": options.instanceId } : {}),
  };
  return {
    TableName: tables.uploadTable,
    IndexName: tables.statusIndex,
    KeyConditionExpression: "#status = :status",
    FilterExpression: filterExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: marshall(expressionAttributeValues),
    ScanIndexForward: true,
  };
}

async function appendUnpausedJobsForStatus(
  client: DynamoDBClient,
  tables: QueueTables,
  options: QueueOptions,
  status: PersonalMediaUploadJobRecord["status"],
  jobs: PersonalMediaUploadJobRecord[],
): Promise<void> {
  const query = statusQuery(tables, options, status);
  let cursor: QueryCommandInput["ExclusiveStartKey"];
  do {
    const result = await client.send(
      new QueryCommand({
        ...query,
        Limit: options.limit - jobs.length,
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of result.Items ?? []) {
      const job = unmarshall(item) as PersonalMediaUploadJobRecord;
      if (!(await getPausedDesktopDraft(tables.control, job))) jobs.push(job);
      if (jobs.length >= options.limit) break;
    }
    cursor = result.LastEvaluatedKey;
  } while (cursor && jobs.length < options.limit);
}
