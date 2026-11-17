variable "enable_sandbox_search_permissions" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_sandbox_search_permissions || (var.enable_private_evidence_store && var.enable_sandbox_terraform_role && var.environment == "sandbox" && var.aws_region == "us-east-1")
    error_message = "Search permissions require the existing reviewed Sandbox bootstrap identity."
  }
}

variable "search_transcripts_bucket" {
  type    = string
  default = ""
  validation {
    condition     = !var.enable_sandbox_search_permissions || can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.search_transcripts_bucket))
    error_message = "Supply the exact existing Sandbox transcripts bucket for metadata reads."
  }
}

locals {
  search_bucket_arn   = "arn:aws:s3vectors:us-east-1:${var.sandbox_account_id}:bucket/meeting-notes-sandbox-search-${var.sandbox_account_id}"
  search_index_arns   = ["${local.search_bucket_arn}/index/meetings-*", "${local.search_bucket_arn}/index/transcripts-*"]
  search_state_arn    = "arn:aws:dynamodb:us-east-1:${var.sandbox_account_id}:table/meeting-notes-sandbox-MeetingSearchState"
  search_role_arn     = "arn:aws:iam::${var.sandbox_account_id}:role/meeting-notes-sandbox-search-projection"
  search_function_arn = "arn:aws:lambda:us-east-1:${var.sandbox_account_id}:function:meeting-notes-sandbox-search-projection"
  search_queue_arn    = "arn:aws:sqs:us-east-1:${var.sandbox_account_id}:meeting-notes-sandbox-search-failures"
  search_log_arn      = "arn:aws:logs:us-east-1:${var.sandbox_account_id}:log-group:/aws/lambda/meeting-notes-sandbox-search-projection"
  search_rule_arn     = "arn:aws:events:us-east-1:${var.sandbox_account_id}:rule/meeting-notes-sandbox-search-reconcile"
  search_provisioning_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "VectorBucket", Effect = "Allow", Action = ["s3vectors:CreateVectorBucket", "s3vectors:GetVectorBucket", "s3vectors:ListIndexes", "s3vectors:ListTagsForResource", "s3vectors:TagResource", "s3vectors:UntagResource"], Resource = local.search_bucket_arn },
      { Sid = "VectorIndexes", Effect = "Allow", Action = ["s3vectors:CreateIndex", "s3vectors:GetIndex", "s3vectors:ListTagsForResource", "s3vectors:TagResource", "s3vectors:UntagResource", "s3vectors:UpdateIndexMode", "s3vectors:UpdateMetadataConfiguration"], Resource = local.search_index_arns },
      { Sid = "SearchState", Effect = "Allow", Action = ["dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:UpdateContinuousBackups", "dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource", "dynamodb:TagResource", "dynamodb:UntagResource"], Resource = local.search_state_arn },
      { Sid = "SearchRole", Effect = "Allow", Action = ["iam:CreateRole", "iam:TagRole", "iam:UntagRole", "iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy"], Resource = local.search_role_arn },
      { Sid = "SearchReader", Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy"], Resource = "arn:aws:iam::${var.sandbox_account_id}:role/meeting-notes-sandbox-ecs-task-app-role" },
      { Sid = "PassProjection", Effect = "Allow", Action = "iam:PassRole", Resource = local.search_role_arn, Condition = { StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" } } },
      { Sid = "ProjectionFunction", Effect = "Allow", Action = ["lambda:CreateFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:PutFunctionConcurrency", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:GetFunctionCodeSigningConfig", "lambda:GetPolicy", "lambda:ListVersionsByFunction", "lambda:ListTags", "lambda:TagResource", "lambda:UntagResource"], Resource = local.search_function_arn },
      { Sid = "ProjectionInvokePermission", Effect = "Allow", Action = "lambda:AddPermission", Resource = local.search_function_arn, Condition = { StringEquals = { "lambda:Principal" = "events.amazonaws.com" } } },
      { Sid = "ProjectionMappingCreate", Effect = "Allow", Action = ["lambda:CreateEventSourceMapping"], Resource = "arn:aws:lambda:us-east-1:${var.sandbox_account_id}:event-source-mapping:*", Condition = { StringEquals = { "lambda:FunctionArn" = local.search_function_arn } } },
      { Sid = "ProjectionMappingMetadata", Effect = "Allow", Action = ["lambda:GetEventSourceMapping", "lambda:ListTags"], Resource = "arn:aws:lambda:us-east-1:${var.sandbox_account_id}:event-source-mapping:*" },
      { Sid = "SearchSchedule", Effect = "Allow", Action = ["events:PutRule", "events:PutTargets", "events:DescribeRule", "events:ListTargetsByRule", "events:ListTagsForResource", "events:TagResource", "events:UntagResource"], Resource = local.search_rule_arn },
      { Sid = "SearchFailureQueue", Effect = "Allow", Action = ["sqs:CreateQueue", "sqs:SetQueueAttributes", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueueTags", "sqs:TagQueue", "sqs:UntagQueue"], Resource = local.search_queue_arn },
      { Sid = "SearchLogs", Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:AssociateKmsKey", "logs:ListTagsForResource", "logs:TagResource", "logs:UntagResource"], Resource = [local.search_log_arn, "${local.search_log_arn}:*"] },
      { Sid = "SearchLogMetadata", Effect = "Allow", Action = "logs:DescribeLogGroups", Resource = "*" },
      { Sid = "SearchDependencyMetadata", Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketPolicy", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetBucketVersioning", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment", "s3:GetBucketLogging", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketTagging"], Resource = "arn:aws:s3:::${var.search_transcripts_bucket}" },
      { Sid = "SearchSecretMetadata", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"], Resource = [for name in ["openai-api-key", "langfuse-public-key", "langfuse-secret-key"] : "arn:aws:secretsmanager:us-east-1:${var.sandbox_account_id}:secret:meeting-notes-sandbox/${name}-*"] },
      { Sid = "SearchStateKey", Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"], Resource = var.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = var.sandbox_account_id, "kms:EncryptionContext:aws:dynamodb:tableName" = "meeting-notes-sandbox-MeetingSearchState", "kms:EncryptionContext:aws:dynamodb:subscriberId" = var.sandbox_account_id } } },
      { Sid = "SearchStateGrant", Effect = "Allow", Action = "kms:CreateGrant", Resource = var.kms_key_arn, Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" }, StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = var.sandbox_account_id, "kms:GranteePrincipal" = "dynamodb.us-east-1.amazonaws.com", "kms:GrantConstraintType" = "EncryptionContextSubset" } } },
    ]
  })
}

# A separate managed policy avoids the existing executor's aggregate inline-policy limit.
resource "aws_iam_policy" "sandbox_search" {
  count       = var.enable_sandbox_search_permissions ? 1 : 0
  name        = "meeting-notes-sandbox-search-provisioning"
  description = "Sandbox search provisioning under exact saved-plan review"
  policy      = jsonencode({ Version = "2012-10-17", Statement = [for statement in jsondecode(local.search_provisioning_policy).Statement : statement if !contains(["SearchStateKey", "SearchStateGrant", "SearchVectorKey"], statement.Sid)] })
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.aws_caller_identity.current[0].account_id == var.sandbox_account_id
      error_message = "Search permissions require the reviewed Sandbox account."
    }
  }
}

resource "aws_iam_role_policy_attachment" "sandbox_search" {
  count      = var.enable_sandbox_search_permissions ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.sandbox_search[0].arn
}

resource "aws_iam_policy" "sandbox_search_keys" {
  count       = var.enable_sandbox_search_permissions ? 1 : 0
  name        = "meeting-notes-sandbox-search-key-use"
  description = "Service-mediated search encryption on the reviewed existing Sandbox key"
  policy      = jsonencode({ Version = "2012-10-17", Statement = [for statement in jsondecode(local.search_provisioning_policy).Statement : statement if contains(["SearchStateKey", "SearchStateGrant", "SearchVectorKey"], statement.Sid)] })
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy_attachment" "sandbox_search_keys" {
  count      = var.enable_sandbox_search_permissions ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.sandbox_search_keys[0].arn
}
