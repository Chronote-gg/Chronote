# -----------------------------------------------------------------------
# Critical alerts: SNS topic, email subscription, and CloudWatch alarms
# -----------------------------------------------------------------------

variable "alert_email" {
  description = "Email address for critical alert notifications (requires manual confirmation after first apply)"
  type        = string
  default     = ""
}

variable "alert_discord_channel_id" {
  description = "Discord channel ID for critical alert notifications (bot must have SendMessages permission)"
  type        = string
  default     = ""
}

locals {
  alerts_enabled         = var.alert_email != "" || var.alert_discord_channel_id != ""
  discord_alerts_enabled = local.alerts_enabled && var.alert_discord_channel_id != ""
}

# --- SNS topic ---

resource "aws_sns_topic" "critical_alerts" {
  count             = local.alerts_enabled ? 1 : 0
  name              = "${local.name_prefix}-critical-alerts"
  kms_master_key_id = aws_kms_key.app_general.arn

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

resource "aws_sns_topic_policy" "critical_alerts" {
  count  = local.alerts_enabled ? 1 : 0
  arn    = aws_sns_topic.critical_alerts[0].arn
  policy = data.aws_iam_policy_document.sns_critical_alerts_policy[0].json
}

data "aws_iam_policy_document" "sns_critical_alerts_policy" {
  count = local.alerts_enabled ? 1 : 0

  statement {
    sid    = "AllowCloudWatchAlarms"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.critical_alerts[0].arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "AllowEventBridge"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.critical_alerts[0].arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_subscription" "critical_alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.critical_alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- ECS: bot completely down (running task count = 0) ---

resource "aws_cloudwatch_metric_alarm" "ecs_no_running_tasks" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-ecs-no-running-tasks"
  alarm_description   = "ECS bot service has zero running tasks"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.app_service.name
  }

  alarm_actions = [aws_sns_topic.critical_alerts[0].arn]
  ok_actions    = [aws_sns_topic.critical_alerts[0].arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# --- ALB: HTTP 5xx spike ---

resource "aws_cloudwatch_metric_alarm" "alb_5xx_errors" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-alb-target-5xx-errors"
  alarm_description   = "ALB targets returning elevated 5xx errors"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.api_alb.arn_suffix
  }

  alarm_actions = [aws_sns_topic.critical_alerts[0].arn]
  ok_actions    = [aws_sns_topic.critical_alerts[0].arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# --- ALB: unhealthy hosts ---

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-alb-unhealthy-hosts"
  alarm_description   = "ALB target group has unhealthy hosts"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.api_alb.arn_suffix
    TargetGroup  = aws_lb_target_group.api_tg.arn_suffix
  }

  alarm_actions = [aws_sns_topic.critical_alerts[0].arn]
  ok_actions    = [aws_sns_topic.critical_alerts[0].arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# -----------------------------------------------------------------------
# Discord alert Lambda: forwards SNS alarm notifications to a Discord channel
# -----------------------------------------------------------------------

data "archive_file" "discord_alert" {
  count       = local.discord_alerts_enabled ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/lambda/discord_alert/handler.mjs"
  output_path = "${path.module}/discord_alert.zip"
}

resource "aws_iam_role" "discord_alert" {
  count = local.discord_alerts_enabled ? 1 : 0
  name  = "${local.name_prefix}-discord-alert"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy" "discord_alert" {
  count = local.discord_alerts_enabled ? 1 : 0
  name  = "discord-alert"
  role  = aws_iam_role.discord_alert[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadBotToken"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [aws_secretsmanager_secret.discord_bot_token.arn]
      },
      {
        Sid    = "DecryptSecrets"
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = [aws_kms_key.app_general.arn]
      },
      {
        Sid    = "WriteLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = ["arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:*"]
      },
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        ]
        Resource = ["*"]
      }
    ]
  })
}

resource "aws_lambda_function" "discord_alert" {
  count         = local.discord_alerts_enabled ? 1 : 0
  function_name = "${local.name_prefix}-discord-alert"
  description   = "Forwards CloudWatch Alarm SNS notifications to a Discord channel"
  role          = aws_iam_role.discord_alert[0].arn
  handler       = "handler.handler"
  runtime       = "nodejs22.x"
  timeout       = 15
  memory_size   = 128

  filename         = data.archive_file.discord_alert[0].output_path
  source_code_hash = data.archive_file.discord_alert[0].output_base64sha256

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      DISCORD_BOT_TOKEN_SECRET_ARN = aws_secretsmanager_secret.discord_bot_token.arn
      DISCORD_CHANNEL_ID           = var.alert_discord_channel_id
    }
  }

  #checkov:skip=CKV_AWS_115 reason: Reserved concurrency not needed for infrequent alert forwarding.
  #checkov:skip=CKV_AWS_116 reason: No DLQ needed; SNS retries on failure and email provides backup alerting.
  #checkov:skip=CKV_AWS_117 reason: Lambda does not need VPC access; calls only Discord API and Secrets Manager.
  #checkov:skip=CKV_AWS_272 reason: Code signing not required for internal infra Lambda.
  #checkov:skip=CKV_AWS_173 reason: Environment variables contain no secrets; ARN and channel ID only.

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "discord_alert" {
  count             = local.discord_alerts_enabled ? 1 : 0
  name              = "/aws/lambda/${aws_lambda_function.discord_alert[0].function_name}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app_general.arn

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

resource "aws_sns_topic_subscription" "critical_alerts_discord" {
  count     = local.discord_alerts_enabled ? 1 : 0
  topic_arn = aws_sns_topic.critical_alerts[0].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.discord_alert[0].arn
}

resource "aws_lambda_permission" "discord_alert_sns" {
  count         = local.discord_alerts_enabled ? 1 : 0
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.discord_alert[0].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.critical_alerts[0].arn
}

