"use strict";
function expectedSearchProvisioningPolicy(accountId, keyArn, transcriptBucket) {
  const arn = (service, suffix) =>
    `arn:aws:${service}:us-east-1:${accountId}:${suffix}`;
  const bucket = arn(
    "s3vectors",
    `bucket/meeting-notes-sandbox-search-${accountId}`,
  );
  const role = `arn:aws:iam::${accountId}:role/meeting-notes-sandbox-search-projection`;
  const fn = arn("lambda", "function:meeting-notes-sandbox-search-projection");
  const logs = arn(
    "logs",
    "log-group:/aws/lambda/meeting-notes-sandbox-search-projection",
  );
  const allow = (Sid, Action, Resource, Condition) => ({
    Sid,
    Effect: "Allow",
    Action,
    Resource,
    ...(Condition ? { Condition } : {}),
  });
  return {
    Version: "2012-10-17",
    Statement: [
      allow(
        "VectorBucket",
        [
          "s3vectors:CreateVectorBucket",
          "s3vectors:GetVectorBucket",
          "s3vectors:ListIndexes",
          "s3vectors:ListTagsForResource",
          "s3vectors:TagResource",
          "s3vectors:UntagResource",
        ],
        bucket,
      ),
      allow(
        "VectorIndexes",
        [
          "s3vectors:CreateIndex",
          "s3vectors:GetIndex",
          "s3vectors:ListTagsForResource",
          "s3vectors:TagResource",
          "s3vectors:UntagResource",
          "s3vectors:UpdateIndexMode",
          "s3vectors:UpdateMetadataConfiguration",
        ],
        [`${bucket}/index/meetings-*`, `${bucket}/index/transcripts-*`],
      ),
      allow(
        "SearchState",
        [
          "dynamodb:CreateTable",
          "dynamodb:UpdateTable",
          "dynamodb:UpdateContinuousBackups",
          "dynamodb:DescribeTable",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:DescribeTimeToLive",
          "dynamodb:ListTagsOfResource",
          "dynamodb:TagResource",
          "dynamodb:UntagResource",
        ],
        arn("dynamodb", "table/meeting-notes-sandbox-MeetingSearchState"),
      ),
      allow(
        "SearchRole",
        [
          "iam:CreateRole",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:GetRole",
          "iam:ListRolePolicies",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:PutRolePolicy",
        ],
        role,
      ),
      allow(
        "SearchReader",
        [
          "iam:GetRole",
          "iam:ListRolePolicies",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:PutRolePolicy",
        ],
        `arn:aws:iam::${accountId}:role/meeting-notes-sandbox-ecs-task-app-role`,
      ),
      allow("PassProjection", "iam:PassRole", role, {
        StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
      }),
      allow(
        "ProjectionFunction",
        [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:PutFunctionConcurrency",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:GetFunctionCodeSigningConfig",
          "lambda:GetPolicy",
          "lambda:ListVersionsByFunction",
          "lambda:ListTags",
          "lambda:TagResource",
          "lambda:UntagResource",
        ],
        fn,
      ),
      allow("ProjectionInvokePermission", "lambda:AddPermission", fn, {
        StringEquals: { "lambda:Principal": "events.amazonaws.com" },
      }),
      allow(
        "ProjectionMappingCreate",
        ["lambda:CreateEventSourceMapping"],
        arn("lambda", "event-source-mapping:*"),
        { StringEquals: { "lambda:FunctionArn": fn } },
      ),
      allow(
        "ProjectionMappingMetadata",
        ["lambda:GetEventSourceMapping", "lambda:ListTags"],
        arn("lambda", "event-source-mapping:*"),
      ),
      allow(
        "SearchSchedule",
        [
          "events:PutRule",
          "events:PutTargets",
          "events:DescribeRule",
          "events:ListTargetsByRule",
          "events:ListTagsForResource",
          "events:TagResource",
          "events:UntagResource",
        ],
        arn("events", "rule/meeting-notes-sandbox-search-reconcile"),
      ),
      allow(
        "SearchFailureQueue",
        [
          "sqs:CreateQueue",
          "sqs:SetQueueAttributes",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ListQueueTags",
          "sqs:TagQueue",
          "sqs:UntagQueue",
        ],
        arn("sqs", "meeting-notes-sandbox-search-failures"),
      ),
      allow(
        "SearchLogs",
        [
          "logs:CreateLogGroup",
          "logs:PutRetentionPolicy",
          "logs:AssociateKmsKey",
          "logs:ListTagsForResource",
          "logs:TagResource",
          "logs:UntagResource",
        ],
        [logs, `${logs}:*`],
      ),
      allow("SearchLogMetadata", "logs:DescribeLogGroups", "*"),
      allow(
        "SearchDependencyMetadata",
        [
          "s3:ListBucket",
          "s3:GetBucketPolicy",
          "s3:GetBucketAcl",
          "s3:GetBucketCORS",
          "s3:GetBucketWebsite",
          "s3:GetBucketVersioning",
          "s3:GetAccelerateConfiguration",
          "s3:GetBucketRequestPayment",
          "s3:GetBucketLogging",
          "s3:GetLifecycleConfiguration",
          "s3:GetReplicationConfiguration",
          "s3:GetEncryptionConfiguration",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetBucketTagging",
        ],
        `arn:aws:s3:::${transcriptBucket}`,
      ),
      allow(
        "SearchSecretMetadata",
        ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"],
        ["openai-api-key", "langfuse-public-key", "langfuse-secret-key"].map(
          (name) =>
            arn("secretsmanager", `secret:meeting-notes-sandbox/${name}-*`),
        ),
      ),
      allow(
        "SearchStateKey",
        [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyWithoutPlaintext",
        ],
        keyArn,
        {
          StringEquals: {
            "kms:ViaService": "dynamodb.us-east-1.amazonaws.com",
            "kms:CallerAccount": accountId,
            "kms:EncryptionContext:aws:dynamodb:tableName":
              "meeting-notes-sandbox-MeetingSearchState",
            "kms:EncryptionContext:aws:dynamodb:subscriberId": accountId,
          },
        },
      ),
      allow("SearchStateGrant", "kms:CreateGrant", keyArn, {
        Bool: { "kms:GrantIsForAWSResource": "true" },
        StringEquals: {
          "kms:ViaService": "dynamodb.us-east-1.amazonaws.com",
          "kms:CallerAccount": accountId,
          "kms:GranteePrincipal": "dynamodb.us-east-1.amazonaws.com",
          "kms:GrantConstraintType": "EncryptionContextSubset",
        },
      }),
    ],
  };
}
module.exports = { expectedSearchProvisioningPolicy };
