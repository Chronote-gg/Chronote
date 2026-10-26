import type {
  TransactWriteItem,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  PersonalMediaUploadJobRecord,
  PersonalRecordingSegmentRecord,
} from "../types/db";
import { pausedDesktopDraftKey } from "../types/deploymentControl";

export function buildUnpausedDesktopDraftCheck(
  uploadId: string,
  table: string,
): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: marshall(pausedDesktopDraftKey(uploadId)),
      ConditionExpression: "attribute_not_exists(pk)",
    },
  };
}
export function buildPersonalUploadSubmissionTransaction(
  job: PersonalMediaUploadJobRecord,
  tables: { deploymentControl: string; personalMediaUpload: string },
): TransactWriteItemsCommandInput {
  return {
    TransactItems: [
      buildUnpausedDesktopDraftCheck(job.uploadId, tables.deploymentControl),
      {
        Put: {
          TableName: tables.personalMediaUpload,
          Item: marshall(job, { removeUndefinedValues: true }),
          ConditionExpression:
            "#status = :pending AND ownerUserId = :owner AND attribute_not_exists(processingClaimId)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({
            ":pending": "pending_upload",
            ":owner": job.ownerUserId,
          }),
        },
      },
    ],
  };
}
export function buildPersonalSegmentTransitionTransaction(
  segment: PersonalRecordingSegmentRecord,
  expectedStatus: PersonalRecordingSegmentRecord["status"],
  tables: { deploymentControl: string; personalRecordingSegment: string },
): TransactWriteItemsCommandInput {
  return {
    TransactItems: [
      buildUnpausedDesktopDraftCheck(
        segment.uploadId,
        tables.deploymentControl,
      ),
      {
        Put: {
          TableName: tables.personalRecordingSegment,
          Item: marshall(segment, { removeUndefinedValues: true }),
          ConditionExpression: "#status = :expected AND ownerUserId = :owner",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({
            ":expected": expectedStatus,
            ":owner": segment.ownerUserId,
          }),
        },
      },
    ],
  };
}

export function buildPendingSegmentTransaction(
  segment: PersonalRecordingSegmentRecord,
  expectedStatus: "pending_upload" | "failed" | undefined,
  tables: {
    personalMediaUpload: string;
    personalRecordingSegment: string;
    deploymentControl: string;
  },
): TransactWriteItemsCommandInput {
  return {
    TransactItems: [
      buildUnpausedDesktopDraftCheck(
        segment.uploadId,
        tables.deploymentControl,
      ),
      {
        ConditionCheck: {
          TableName: tables.personalMediaUpload,
          Key: marshall({ uploadId: segment.uploadId }),
          ConditionExpression:
            "#status = :pending AND ownerUserId = :owner AND attribute_not_exists(processingClaimId)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall({
            ":pending": "pending_upload",
            ":owner": segment.ownerUserId,
          }),
        },
      },
      {
        Put: {
          TableName: tables.personalRecordingSegment,
          Item: marshall(segment, { removeUndefinedValues: true }),
          ConditionExpression: expectedStatus
            ? "#status = :expected AND ownerUserId = :owner"
            : "attribute_not_exists(uploadId)",
          ...(expectedStatus
            ? {
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: marshall({
                  ":expected": expectedStatus,
                  ":owner": segment.ownerUserId,
                }),
              }
            : {}),
        },
      },
    ],
  };
}
