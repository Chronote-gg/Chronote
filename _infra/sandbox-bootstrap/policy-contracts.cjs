"use strict";
// Fixed independently reviewed contract; provider-computed controls are checked separately.
function expectedBucketPolicy(input) {
  const reviewedReaders = [
    `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
    input.reviewer_role_arn,
  ];
  return {
    Statement: [
      {
        Action: "s3:*",
        Condition: {
          Bool: {
            "aws:SecureTransport": "false",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "TLSOnly",
      },
      {
        Action: "s3:*",
        Condition: {
          ArnNotEquals: {
            "aws:PrincipalArn": [
              `${input.administrator_role_arn}`,
              `${input.reviewer_role_arn}`,
              `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
            ],
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "OnlyReviewedPrincipals",
      },
      {
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
          },
        },
        Effect: "Deny",
        NotAction: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:PutObject",
          "s3:GetObjectVersion",
        ],
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "CaptureCannotAdminister",
      },
      {
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `${input.reviewer_role_arn}`,
          },
          ArnNotEquals: {
            "aws:PrincipalArn": `${input.administrator_role_arn}`,
          },
        },
        Effect: "Deny",
        NotAction: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
          "s3:GetObjectVersion",
          "s3:ListBucketVersions",
        ],
        Principal: "*",
        Resource: [
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
          `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        ],
        Sid: "ReviewerCannotWrite",
      },
      {
        Action: "s3:ListBucketVersions",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `${input.reviewer_role_arn}`,
          },
          ArnNotEquals: {
            "aws:PrincipalArn": `${input.administrator_role_arn}`,
          },
          StringNotLike: {
            "s3:prefix": "terraform/sandbox/*",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
        Sid: "ReviewerNamespaceListOnly",
      },
      {
        Action: ["s3:PutObject", "s3:GetObjectVersion"],
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": reviewedReaders,
          },
          ArnNotEquals: {
            "aws:PrincipalArn": `${input.administrator_role_arn}`,
          },
        },
        Effect: "Deny",
        NotResource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Principal: "*",
        Sid: "CaptureNamespaceOnly",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringNotEquals: {
            "s3:if-none-match": "*",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        Sid: "ConditionalCreateOnly",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringNotEquals: {
            "s3:x-amz-server-side-encryption": "aws:kms",
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        Sid: "ExactKMSAlgorithm",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringNotEquals: {
            "s3:x-amz-server-side-encryption-aws-kms-key-id": `${input.kms_key_arn}`,
          },
        },
        Effect: "Deny",
        Principal: "*",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/*`,
        Sid: "ExactKMSKey",
      },
      {
        Action: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
        ],
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": reviewedReaders,
          },
        },
        Effect: "Allow",
        Principal: {
          AWS: `arn:aws:iam::${input.sandbox_account_id}:root`,
        },
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
        Sid: "ControlReadback",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-terraform`,
          },
          StringEquals: {
            "s3:if-none-match": "*",
            "s3:x-amz-server-side-encryption": "aws:kms",
            "s3:x-amz-server-side-encryption-aws-kms-key-id": `${input.kms_key_arn}`,
          },
        },
        Effect: "Allow",
        Principal: {
          AWS: `arn:aws:iam::${input.sandbox_account_id}:root`,
        },
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ConditionalCapture",
      },
      {
        Action: "s3:GetObjectVersion",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": reviewedReaders,
          },
        },
        Effect: "Allow",
        Principal: {
          AWS: `arn:aws:iam::${input.sandbox_account_id}:root`,
        },
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ExactVersionReview",
      },
    ],
    Version: "2012-10-17",
  };
}

// Fixed independently reviewed contract; provider-computed controls are checked separately.
function expectedTrustPolicy(input) {
  return {
    Statement: [
      {
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:ref": [
              "refs/heads/codex/sandbox-terraform-capture",
              "refs/heads/master",
            ],
            "token.actions.githubusercontent.com:repository_id": `${input.github_repository_id}`,
            "token.actions.githubusercontent.com:repository_owner_id": `${input.github_owner_id}`,
            "token.actions.githubusercontent.com:sub":
              "repo:Chronote-gg/Chronote:environment:sandbox",
          },
        },
        Effect: "Allow",
        Principal: {
          Federated: `arn:aws:iam::${input.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com`,
        },
      },
    ],
    Version: "2012-10-17",
  };
}

// Fixed independently reviewed contract; provider-computed controls are checked separately.
function expectedRolePolicy(input) {
  return {
    Statement: [
      {
        Sid: "SitePolicy",
        Effect: "Allow",
        Action: [
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:ListPolicyTags",
          "iam:ListPolicyVersions",
          "iam:CreatePolicy",
          "iam:TagPolicy",
          "iam:CreatePolicyVersion",
        ],
        Resource: `arn:aws:iam::${input.sandbox_account_id}:policy/meeting-notes-sandbox-site-publishing`,
      },
      {
        Sid: "SiteAttachment",
        Effect: "Allow",
        Action: "iam:AttachRolePolicy",
        Resource: `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-deploy`,
        Condition: {
          StringEquals: {
            "iam:PolicyARN": `arn:aws:iam::${input.sandbox_account_id}:policy/meeting-notes-sandbox-site-publishing`,
          },
        },
      },
      {
        Sid: "SiteRoleMetadata",
        Effect: "Allow",
        Action: [
          "iam:GetRole",
          "iam:ListRolePolicies",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
        ],
        Resource: `arn:aws:iam::${input.sandbox_account_id}:role/meeting-notes-sandbox-github-deploy`,
      },
      {
        Sid: "SiteBucketMetadata",
        Effect: "Allow",
        Action: [
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
        Resource: [
          `arn:aws:s3:::${input.site_frontend_bucket}`,
          `arn:aws:s3:::${input.site_docs_bucket}`,
        ],
      },
      {
        Sid: "SiteOidcMetadata",
        Effect: "Allow",
        Action: ["iam:GetOpenIDConnectProvider"],
        Resource: `arn:aws:iam::${input.sandbox_account_id}:oidc-provider/token.actions.githubusercontent.com`,
      },
      {
        Action: ["s3:GetObject", "s3:PutObject"],
        Effect: "Allow",
        Resource:
          "arn:aws:s3:::meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state",
        Sid: "ApplicationState",
      },
      {
        Action: "s3:ListBucket",
        Condition: {
          StringEquals: {
            "s3:prefix": [
              "meeting-notes-terraform/",
              "meeting-notes-terraform/sandbox/",
            ],
          },
        },
        Effect: "Allow",
        Resource: "arn:aws:s3:::meeting-notes-terraform-state-bucket",
        Sid: "WorkspaceDiscovery",
      },
      {
        Action: "dynamodb:DescribeTable",
        Effect: "Allow",
        Resource: `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-terraform-state-locks`,
        Sid: "StateLockMetadata",
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [
              "meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state",
              "meeting-notes-terraform-state-bucket/meeting-notes-terraform/sandbox/meeting-notes-terraform/state-md5",
            ],
          },
        },
        Effect: "Allow",
        Resource: `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-terraform-state-locks`,
        Sid: "SandboxStateLocks",
      },
      {
        Action: [
          "dynamodb:DescribeTable",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:DescribeTimeToLive",
          "dynamodb:ListTagsOfResource",
        ],
        Effect: "Allow",
        Resource: [
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-AccessLogsTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ActiveMeetingTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-AskConversationTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-AutoRecordSettingsTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ChannelContextTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ChatTtsUsageTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ConfigOverridesTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ContactFeedbackTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-DeploymentControlTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-DictionaryTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-EntitlementGrantTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-FeedbackTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-GuildSubscriptionTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-InstallerTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-InteractionReceiptTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-McpOAuthTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingControlCommandTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingHistoryTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingShareTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingUserIndexTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-NotionIntegrationTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-OnboardingStateTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-PaymentTransactionTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-PersonalMediaUploadJobTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-PersonalRecordingSegmentTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-RecordingTranscriptTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-ServerContextTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-SessionTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-StripeWebhookEventTable`,
          `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-UserSpeechSettingsTable`,
        ],
        Sid: "TableMetadata",
      },
      {
        Action: ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags"],
        Effect: "Allow",
        Resource: `arn:aws:iam::${input.sandbox_account_id}:policy/meeting-notes-sandbox-bot-dynamodb-policy`,
        Sid: "RuntimePolicyMetadata",
      },
      {
        Action: [
          "kms:DescribeKey",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:ListResourceTags",
        ],
        Effect: "Allow",
        Resource: `${input.kms_key_arn}`,
        Sid: "KeyMetadata",
      },
      {
        Action: "dynamodb:UpdateTable",
        Effect: "Allow",
        Resource: `arn:aws:dynamodb:us-east-1:${input.sandbox_account_id}:table/meeting-notes-sandbox-MeetingHistoryTable`,
        Sid: "HistoryDeliveryIndex",
      },
      {
        Action: ["iam:ListPolicyVersions", "iam:CreatePolicyVersion"],
        Effect: "Allow",
        Resource: `arn:aws:iam::${input.sandbox_account_id}:policy/meeting-notes-sandbox-bot-dynamodb-policy`,
        Sid: "RuntimePolicyVersion",
      },
      {
        Action: [
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicyStatus",
          "s3:GetBucketPolicy",
          "s3:GetEncryptionConfiguration",
          "s3:GetLifecycleConfiguration",
        ],
        Effect: "Allow",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}`,
        Sid: "CaptureControls",
      },
      {
        Action: "s3:PutObject",
        Condition: {
          StringEquals: {
            "s3:if-none-match": "*",
            "s3:x-amz-server-side-encryption": "aws:kms",
            "s3:x-amz-server-side-encryption-aws-kms-key-id": `${input.kms_key_arn}`,
          },
        },
        Effect: "Allow",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ConditionalCapture",
      },
      {
        Action: "s3:GetObjectVersion",
        Effect: "Allow",
        Resource: `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
        Sid: "ExactVersionCapture",
      },
      {
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Condition: {
          StringEquals: {
            "kms:CallerAccount": `${input.sandbox_account_id}`,
            "kms:ViaService": "s3.us-east-1.amazonaws.com",
          },
          StringLike: {
            "kms:EncryptionContext:aws:s3:arn": `arn:aws:s3:::meeting-notes-sandbox-private-evidence-${input.sandbox_account_id}/terraform/sandbox/*`,
          },
        },
        Effect: "Allow",
        Resource: `${input.kms_key_arn}`,
        Sid: "CaptureKeyUse",
      },
    ],
    Version: "2012-10-17",
  };
}

module.exports = {
  expectedBucketPolicy,
  expectedTrustPolicy,
  expectedRolePolicy,
};
