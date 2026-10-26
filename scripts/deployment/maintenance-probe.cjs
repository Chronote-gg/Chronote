"use strict";
const { validateBinding } = require("./maintenance-fence.cjs");
// Frozen593a acquisition shapes. Contradictory real-key conditions prevent all writes.
function buildProbeRequests(binding) {
  validateBinding(binding);
  return {
    meetingAcquire: {
      action: "PutItem",
      request: {
        TableName: binding.activeMeetingTableArn,
        Item: {
          guildId: {
            S: binding.operationId,
          },
          meetingId: {
            S: binding.operationId,
          },
          ownerInstanceId: {
            S: binding.operationId,
          },
          voiceChannelId: {
            S: binding.operationId,
          },
          textChannelId: {
            S: binding.operationId,
          },
          isAutoRecording: {
            BOOL: false,
          },
          status: {
            S: "in_progress",
          },
          leaseExpiresAt: {
            N: "30",
          },
          createdAt: {
            S: "1970-01-01T00:00:00.000Z",
          },
          updatedAt: {
            S: "1970-01-01T00:00:00.000Z",
          },
          expiresAt: {
            N: "150",
          },
        },
        ConditionExpression:
          "(attribute_not_exists(#guildId) OR #leaseExpiresAt < :now OR (#ownerInstanceId = :ownerInstanceId AND #meetingId = :meetingId)) AND attribute_exists(#maintenanceKey) AND attribute_not_exists(#maintenanceKey)",
        ExpressionAttributeNames: {
          "#guildId": "guildId",
          "#leaseExpiresAt": "leaseExpiresAt",
          "#ownerInstanceId": "ownerInstanceId",
          "#meetingId": "meetingId",
          "#maintenanceKey": "guildId",
        },
        ExpressionAttributeValues: {
          ":now": {
            N: "0",
          },
          ":ownerInstanceId": {
            S: binding.operationId,
          },
          ":meetingId": {
            S: binding.operationId,
          },
        },
      },
    },
    uploadClaim: {
      action: "UpdateItem",
      request: {
        TableName: binding.personalMediaUploadJobTableArn,
        Key: {
          uploadId: {
            S: binding.operationId,
          },
        },
        UpdateExpression:
          "SET #status = :processing, #processingOwnerInstanceId = :instanceId, #claimExpiresAt = :claimExpiresAt, #processingStartedAt = if_not_exists(#processingStartedAt, :updatedAt), #updatedAt = :updatedAt, #attempts = if_not_exists(#attempts, :zero) + :one",
        ConditionExpression:
          "((#status = :queued OR (#status = :processing AND (attribute_not_exists(#claimExpiresAt) OR #claimExpiresAt < :nowEpochSeconds))) AND (attribute_not_exists(#attempts) OR #attempts < :maxAttempts)) AND attribute_exists(#maintenanceKey) AND attribute_not_exists(#maintenanceKey)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#processingOwnerInstanceId": "processingOwnerInstanceId",
          "#claimExpiresAt": "claimExpiresAt",
          "#processingStartedAt": "processingStartedAt",
          "#updatedAt": "updatedAt",
          "#attempts": "attempts",
          "#maintenanceKey": "uploadId",
        },
        ExpressionAttributeValues: {
          ":queued": {
            S: "queued",
          },
          ":processing": {
            S: "processing",
          },
          ":instanceId": {
            S: binding.operationId,
          },
          ":claimExpiresAt": {
            N: "30",
          },
          ":nowEpochSeconds": {
            N: "0",
          },
          ":updatedAt": {
            S: "1970-01-01T00:00:00.000Z",
          },
          ":zero": {
            N: "0",
          },
          ":one": {
            N: "1",
          },
          ":maxAttempts": {
            N: "3",
          },
        },
        ReturnValues: "ALL_NEW",
      },
    },
    uploadRenew: {
      action: "UpdateItem",
      request: {
        TableName: binding.personalMediaUploadJobTableArn,
        Key: {
          uploadId: {
            S: binding.operationId,
          },
        },
        UpdateExpression:
          "SET #claimExpiresAt = :claimExpiresAt, #updatedAt = :updatedAt",
        ConditionExpression:
          "(#status = :processing AND #processingOwnerInstanceId = :instanceId) AND attribute_exists(#maintenanceKey) AND attribute_not_exists(#maintenanceKey)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#processingOwnerInstanceId": "processingOwnerInstanceId",
          "#claimExpiresAt": "claimExpiresAt",
          "#updatedAt": "updatedAt",
          "#maintenanceKey": "uploadId",
        },
        ExpressionAttributeValues: {
          ":processing": {
            S: "processing",
          },
          ":instanceId": {
            S: binding.operationId,
          },
          ":claimExpiresAt": {
            N: "30",
          },
          ":updatedAt": {
            S: "1970-01-01T00:00:00.000Z",
          },
        },
      },
    },
    uploadProgress: {
      action: "UpdateItem",
      request: {
        TableName: binding.personalMediaUploadJobTableArn,
        Key: {
          uploadId: {
            S: binding.operationId,
          },
        },
        UpdateExpression:
          "SET #segmentCount = :segmentCount, #uploadedSegmentCount = :uploadedSegmentCount, #processedSegmentCount = :processedSegmentCount, #updatedAt = :updatedAt",
        ConditionExpression:
          "(#status = :processing AND #processingOwnerInstanceId = :instanceId) AND attribute_exists(#maintenanceKey) AND attribute_not_exists(#maintenanceKey)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#processingOwnerInstanceId": "processingOwnerInstanceId",
          "#segmentCount": "segmentCount",
          "#uploadedSegmentCount": "uploadedSegmentCount",
          "#processedSegmentCount": "processedSegmentCount",
          "#updatedAt": "updatedAt",
          "#maintenanceKey": "uploadId",
        },
        ExpressionAttributeValues: {
          ":processing": {
            S: "processing",
          },
          ":instanceId": {
            S: binding.operationId,
          },
          ":segmentCount": {
            N: "0",
          },
          ":uploadedSegmentCount": {
            N: "0",
          },
          ":processedSegmentCount": {
            N: "0",
          },
          ":updatedAt": {
            S: "1970-01-01T00:00:00.000Z",
          },
        },
      },
    },
    meetingRelease: {
      action: "DeleteItem",
      request: {
        TableName: binding.activeMeetingTableArn,
        Key: {
          guildId: {
            S: binding.operationId,
          },
        },
        ConditionExpression:
          "(#meetingId = :meetingId AND #ownerInstanceId = :ownerInstanceId) AND attribute_exists(#maintenanceKey) AND attribute_not_exists(#maintenanceKey)",
        ExpressionAttributeNames: {
          "#meetingId": "meetingId",
          "#ownerInstanceId": "ownerInstanceId",
          "#maintenanceKey": "guildId",
        },
        ExpressionAttributeValues: {
          ":meetingId": {
            S: binding.operationId,
          },
          ":ownerInstanceId": {
            S: binding.operationId,
          },
        },
      },
    },
    meetingRenew: {
      action: "UpdateItem",
      request: {
        TableName: binding.activeMeetingTableArn,
        Key: {
          guildId: {
            S: binding.operationId,
          },
        },
        UpdateExpression:
          "SET #leaseExpiresAt = :leaseExpiresAt, #updatedAt = :updatedAt, #expiresAt = :expiresAt, #status = :status",
        ConditionExpression:
          "(#meetingId = :meetingId AND #ownerInstanceId = :ownerInstanceId) AND attribute_exists(#maintenanceKey) AND attribute_not_exists(#maintenanceKey)",
        ExpressionAttributeNames: {
          "#leaseExpiresAt": "leaseExpiresAt",
          "#updatedAt": "updatedAt",
          "#expiresAt": "expiresAt",
          "#status": "status",
          "#meetingId": "meetingId",
          "#ownerInstanceId": "ownerInstanceId",
          "#maintenanceKey": "guildId",
        },
        ExpressionAttributeValues: {
          ":leaseExpiresAt": {
            N: "30",
          },
          ":updatedAt": {
            S: "1970-01-01T00:00:00.000Z",
          },
          ":expiresAt": {
            N: "150",
          },
          ":status": {
            S: "in_progress",
          },
          ":meetingId": {
            S: binding.operationId,
          },
          ":ownerInstanceId": {
            S: binding.operationId,
          },
        },
      },
    },
  };
}
function classifyProbe({ errorName }) {
  if (errorName === "AccessDeniedException") return "iam_denied";
  if (errorName === "ConditionalCheckFailedException")
    return "condition_refused";
  return "unavailable";
}
module.exports = { buildProbeRequests, classifyProbe };
