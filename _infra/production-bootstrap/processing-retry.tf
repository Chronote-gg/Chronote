# Grants for the processing-retry Plan/Apply scope. A managed policy for the
# same reason as site delivery: the role's inline policies sit near IAM's
# shared 10,240 limit. Table metadata reads and the DynamoDB service grant
# stay in the inline TableMetadata and ControlServiceGrant statements.
variable "enable_processing_retry_policy" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_processing_retry_policy || var.enable_production_terraform_role
    error_message = "The processing retry policy attaches to the production Terraform role."
  }
}
locals {
  retry_region       = "us-east-1:${var.production_account_id}"
  retry_log_group    = "arn:aws:logs:${local.retry_region}:log-group:/ecs/meeting-notes-prod-bot"
  retry_failure_name = "meeting-notes-prod-processing-retry-worker-failed"
}
resource "aws_iam_policy" "processing_retry" {
  count = var.enable_processing_retry_policy ? 1 : 0
  name  = "meeting-notes-prod-terraform-processing-retry"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # The validator lets the update add only ProcessingRetryDueIndex and its keys.
      { Sid = "HistoryRetryIndex", Effect = "Allow", Action = "dynamodb:UpdateTable", Resource = "arn:aws:dynamodb:${local.retry_region}:table/meeting-notes-prod-MeetingHistoryTable" },
      # Index backfill on a customer-managed-key table, as RenewalIndex needs for GuildSubscription.
      { Sid = "HistoryEncryption", Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"], Resource = var.kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.us-east-1.amazonaws.com", "kms:CallerAccount" = var.production_account_id, "kms:EncryptionContext:aws:dynamodb:tableName" = "meeting-notes-prod-MeetingHistoryTable", "kms:EncryptionContext:aws:dynamodb:subscriberId" = var.production_account_id } } },
      # DescribeLogGroups filters by name prefix and cannot name one group.
      # No delete: metric filters have no ARN, so DeleteMetricFilter would reach
      # every filter on the app log group, and the validator refuses deletes.
      { Sid = "LogGroupDiscovery", Effect = "Allow", Action = "logs:DescribeLogGroups", Resource = "arn:aws:logs:${local.retry_region}:log-group:*" },
      { Sid = "AppLogGroup", Effect = "Allow", Action = ["logs:ListTagsForResource", "logs:DescribeMetricFilters", "logs:PutMetricFilter"], Resource = [local.retry_log_group, "${local.retry_log_group}:*"] },
      # Default tags travel with PutMetricAlarm.
      { Sid = "RetryWorkerAlarm", Effect = "Allow", Action = ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource", "cloudwatch:ListTagsForResource"], Resource = "arn:aws:cloudwatch:${local.retry_region}:alarm:${local.retry_failure_name}" },
      { Sid = "CriticalAlertsTopic", Effect = "Allow", Action = ["sns:GetTopicAttributes", "sns:ListTagsForResource"], Resource = "arn:aws:sns:${local.retry_region}:meeting-notes-prod-critical-alerts" }
    ]
  })
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role_policy_attachment" "processing_retry" {
  count      = var.enable_processing_retry_policy ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.processing_retry[0].arn
  depends_on = [aws_iam_role.production_terraform]
  lifecycle { prevent_destroy = true }
}
