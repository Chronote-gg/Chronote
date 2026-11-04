# Grants for the production alerting and ALB access-log resources. A managed
# policy for the same reason as site delivery and processing retry: the role's
# inline policy sits near IAM's 10,240-character limit, and these grants do not
# have to be inline to take effect.
#
# logs:PutMetricFilter for the two new voice metric filters needs nothing here:
# the processing-retry policy's AppLogGroup statement already grants it on the
# app log group ARN, and a metric filter has no ARN of its own, so that grant
# already reaches every filter on that group. Keep both policies attached.
#
# The access-log bucket is the role's first S3 write outside the application
# state object and the private evidence bucket. It is scoped to that one bucket.
variable "enable_alerting_delivery_policy" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_alerting_delivery_policy || var.enable_production_terraform_role
    error_message = "The alerting delivery policy attaches to the production Terraform role."
  }
}
locals {
  alerting_region = "us-east-1:${var.production_account_id}"
  alb_logs_bucket = "arn:aws:s3:::meeting-notes-prod-alb-logs-${var.production_account_id}"
  api_alb_arn     = "arn:aws:elasticloadbalancing:${local.alerting_region}:loadbalancer/app/meeting-notes-prod-api/*"
  # Exact alarm names, checked against the alerting change. Seven are new;
  # alb-unhealthy-hosts already exists and the alerting change updates it in
  # place (count to for_each, and a per-target-group description), which is
  # still a PutMetricAlarm on that name. It keeps its original name so the live
  # alarm is not destroyed and recreated, and alb-spare-unhealthy-hosts is the
  # second alarm for the spare target group, not a rename of it. The two
  # ephemeral-storage alarms are one pair on one metric, an hourly Minimum for a
  # slow leak and a five-minute Maximum for an imminent ceiling. A missing or
  # mistyped name denies PutMetricAlarm rather than granting something wider.
  alerting_alarms  = ["alb-elb-5xx-errors", "alb-elb-5xx-sustained", "alb-unhealthy-hosts", "alb-spare-unhealthy-hosts", "ecs-ephemeral-storage-leak", "ecs-ephemeral-storage-critical", "voice-settlement-unresolved", "voice-admission-blocked"]
  alb_logs_writes  = ["s3:CreateBucket", "s3:PutBucketPolicy", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration", "s3:PutBucketPublicAccessBlock", "s3:PutBucketOwnershipControls", "s3:PutLifecycleConfiguration", "s3:PutBucketTagging"]
  alb_logs_refresh = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketPolicy", "s3:GetBucketPolicyStatus", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketOwnershipControls", "s3:GetLifecycleConfiguration", "s3:GetBucketTagging", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketWebsite", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment", "s3:GetBucketLogging", "s3:GetReplicationConfiguration", "s3:GetBucketObjectLockConfiguration"]
}
resource "aws_iam_policy" "alerting_delivery" {
  count = var.enable_alerting_delivery_policy ? 1 : 0
  name  = "meeting-notes-prod-terraform-alerting-delivery"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Exact alarm names, as RetryWorkerAlarm does. Default tags travel with
      # PutMetricAlarm. No DeleteAlarms: a saved plan must not retire an alarm.
      { Sid = "AlertingAlarms", Effect = "Allow", Action = ["cloudwatch:PutMetricAlarm", "cloudwatch:DescribeAlarms", "cloudwatch:TagResource", "cloudwatch:ListTagsForResource"], Resource = [for name in local.alerting_alarms : "arn:aws:cloudwatch:${local.alerting_region}:alarm:meeting-notes-prod-${name}"] },
      # No DeleteBucket and no object permission: the role creates and configures
      # the log bucket, and never reads or removes a delivered access log.
      { Sid = "AlbLogBucketCreate", Effect = "Allow", Action = local.alb_logs_writes, Resource = local.alb_logs_bucket },
      { Sid = "AlbLogBucketRefresh", Effect = "Allow", Action = local.alb_logs_refresh, Resource = local.alb_logs_bucket },
      # Enabling access logging on the API load balancer. The ARN's trailing
      # segment is generated, so it stays a suffix wildcard on the exact name.
      { Sid = "ApiAccessLogging", Effect = "Allow", Action = "elasticloadbalancing:ModifyLoadBalancerAttributes", Resource = local.api_alb_arn }
    ]
  })
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role_policy_attachment" "alerting_delivery" {
  count      = var.enable_alerting_delivery_policy ? 1 : 0
  role       = local.terraform_role_name
  policy_arn = aws_iam_policy.alerting_delivery[0].arn
  depends_on = [aws_iam_role.production_terraform]
  lifecycle { prevent_destroy = true }
}
