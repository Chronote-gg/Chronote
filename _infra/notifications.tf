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
  critical_alerts_topic  = "${local.name_prefix}-critical-alerts"
}

# --- SNS topic ---

resource "aws_sns_topic" "critical_alerts" {
  depends_on        = [aws_kms_key_policy.app_general]
  count             = local.alerts_enabled ? 1 : 0
  name              = local.critical_alerts_topic
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
  # treat_missing_data is "breaching", so a parked environment would sit in ALARM
  # and page for its intended state.
  count               = local.alerts_enabled && var.ECS_DESIRED_COUNT > 0 ? 1 : 0
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

# --- ECS: the task's disk filling up ---
# A task with a full disk keeps running, keeps passing its health check and
# keeps answering the load balancer, so every other alarm in this file reads OK
# while recording, transcription and notes all fail on write. That is how the
# serving task reached 21 GB used and 0 free with every alarm in the account
# green.
#
# Both thresholds are fractions of 21.47 GB, which is the decimal-GB reading of
# the 20 GiB Fargate DEFAULT. `ephemeralStorageSizeInGiB` is not declared on
# aws_ecs_task_definition.app_task, so that default is what the task gets and
# `EphemeralStorageReserved` sits flat at 21.47. IF EPHEMERAL STORAGE IS EVER
# DECLARED OR RAISED, BOTH THRESHOLDS BELOW MUST MOVE WITH IT, or the leak alarm
# becomes a routine-usage alarm and the ceiling alarm stops meaning "nearly
# full".
#
# The two are a deliberate pair and neither is redundant: they share a metric
# and dimensions and differ in statistic and time base, so one catches a slow
# leak over hours and the other an imminent ceiling within five minutes.
# Deleting either reopens half the gap.

# The statistic is the whole point of this alarm. Healthy operation peaks to
# 19.4 and 19.5 GB during a busy hour and falls back to a 13.3 GB floor, so a
# static threshold on Average or Maximum fires on healthy traffic and gets muted
# as noise. Only a leak raises the FLOOR: the measured leak took the hourly
# minimum from 13.3 to 18.1 overnight and then to the 21.5 ceiling. Minimum over
# an hour separates 13.3 from 18.1 cleanly and ignores the 19.4 peak entirely.
resource "aws_cloudwatch_metric_alarm" "ecs_ephemeral_storage_leak" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-ecs-ephemeral-storage-leak"
  alarm_description   = "The bot task's disk usage never drops below 16 GB of its 21.47 GB, so something is accumulating rather than being cleaned up. Check for leftover meeting audio and transcript files in the task's working directories."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "EphemeralStorageUtilized"
  statistic           = "Minimum"
  period              = 3600
  evaluation_periods  = 3
  threshold           = 16
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

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

# The fast half of the pair: Maximum over five minutes, because once the disk is
# this close to full the peak is what matters and there is no room left to wait
# three hours for a floor to confirm.
resource "aws_cloudwatch_metric_alarm" "ecs_ephemeral_storage_critical" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-ecs-ephemeral-storage-critical"
  alarm_description   = "The bot task's disk is within 5 percent of full (20.4 of 21.47 GB). Recording, transcription and notes writes are about to start failing while the task stays healthy."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "EphemeralStorageUtilized"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 20.4
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

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
  count               = local.alerts_enabled && var.ENABLE_API_ALB ? 1 : 0
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
    LoadBalancer = aws_lb.api_alb[0].arn_suffix
  }

  alarm_actions = [aws_sns_topic.critical_alerts[0].arn]
  ok_actions    = [aws_sns_topic.critical_alerts[0].arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# --- ALB: load balancer answering its own 5xx ---
# Distinct from the target 5xx alarm above: the load balancer returns 502, 503
# or 504 itself when it has no healthy target to forward to, and target 5xx
# stays at zero throughout. That is the only metric that sees a generation swap
# landing on an empty target group.
#
# This alarm is deliberately MORE SENSITIVE than the target 5xx alarm above, and
# the two should not be harmonised. Target 5xx is an application error rate,
# where a higher bar is right because some failures are always in flight. An ELB
# 5xx means the load balancer had nothing healthy to forward to, which is rarely
# benign at any volume. The earlier 10-over-two-periods setting was copied from
# the target alarm and would not have fired on the outage that motivated this
# one, where ELB 5xx arrived as a low trickle while target 5xx stayed at zero.
#
# This is the FAST half of a deliberate pair with alb_elb_5xx_sustained below.
# It catches a concentrated burst within five minutes. On its own it misses a
# trickle that never reaches five in any single period, which is why the slow
# half exists. Read that comment before changing either.

resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx_errors" {
  count               = local.alerts_enabled && var.ENABLE_API_ALB ? 1 : 0
  alarm_name          = "${local.name_prefix}-alb-elb-5xx-errors"
  alarm_description   = "The ALB itself is returning 5xx, which means it has no healthy target to forward to"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.api_alb[0].arn_suffix
  }

  alarm_actions = [aws_sns_topic.critical_alerts[0].arn]
  ok_actions    = [aws_sns_topic.critical_alerts[0].arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# --- ALB: load balancer 5xx sustained over an hour ---
# The SLOW half of the pair with alb_elb_5xx_errors above. Same metric and
# dimension, different time base, and NEITHER IS REDUNDANT: two alarms on one
# metric look like duplication, so this is the note that explains why deleting
# one would reopen the gap both exist to close.
#
# The fast alarm needs five occurrences inside a single five-minute period, so it
# sees a concentrated burst quickly and misses a trickle entirely. This one sums
# over an hour, so it sees a trickle that never reaches five in any one period,
# at the cost of up to an hour of latency. Neither time base covers both shapes.
#
# This is sized against the 2026-11-02 outage, which produced 4, 14 and 2 ELB
# 5xx across three consecutive hourly buckets while target 5xx stayed at zero.
# The 14 crosses this threshold, so the incident would have paged. To be exact
# rather than reassuring: the 4 and the 2 are still under five even hourly, so
# the pair catches that incident, not every individual hour of it.
#
# Accepted cost: a burst large enough to trip the fast alarm will usually trip
# this one too, so one event can notify twice. Two notifications for a real
# outage is cheaper than the missed detection this closes.
#
# Period 3600 is not a novel shape here; the checkout-lock alarm already uses it.

resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx_sustained" {
  count               = local.alerts_enabled && var.ENABLE_API_ALB ? 1 : 0
  alarm_name          = "${local.name_prefix}-alb-elb-5xx-sustained"
  alarm_description   = "The ALB has returned 5xx repeatedly over an hour without ever spiking. Low-rate loss of healthy targets; check target group health across the window."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.api_alb[0].arn_suffix
  }

  alarm_actions = [aws_sns_topic.critical_alerts[0].arn]
  ok_actions    = [aws_sns_topic.critical_alerts[0].arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# --- ALB: unhealthy hosts, one alarm per half of the blue/green pair ---
# A single hardcoded target group dimension is wrong again after the next
# generation swap, which is how this alarm came to be pinned OK on a group with
# no registered targets. Covering both groups makes coverage follow traffic: the
# idle group publishes no UnHealthyHostCount datapoints, and with notBreaching
# its alarm sits OK until it starts serving.

locals {
  alb_unhealthy_host_alarms = local.alerts_enabled && var.ENABLE_API_ALB ? {
    # api_tg keeps the original alarm name so the live alarm is not replaced.
    api_tg = {
      alarm_name   = "${local.name_prefix}-alb-unhealthy-hosts"
      target_group = aws_lb_target_group.api_tg[0].arn_suffix
    }
    api_spare = {
      alarm_name   = "${local.name_prefix}-alb-spare-unhealthy-hosts"
      target_group = aws_lb_target_group.api_spare_tg[0].arn_suffix
    }
  } : {}
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  for_each            = local.alb_unhealthy_host_alarms
  alarm_name          = each.value.alarm_name
  alarm_description   = "ALB target group ${each.key} has unhealthy hosts"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.api_alb[0].arn_suffix
    TargetGroup  = each.value.target_group
  }

  alarm_actions = [aws_sns_topic.critical_alerts[0].arn]
  ok_actions    = [aws_sns_topic.critical_alerts[0].arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# --- Billing: checkout lock that will not release on its own ---
# Matches the STUCK_CHECKOUT_LOG text in src/services/initialPurchaseService.ts.
# It is logged only when a billing page load finds the row stuck, so a server
# nobody revisits stays silent; this catches the lock someone is blocked by.

resource "aws_cloudwatch_log_metric_filter" "checkout_lock_stuck" {
  name           = "${local.name_prefix}-checkout-lock-stuck"
  log_group_name = aws_cloudwatch_log_group.app_log_group.name
  pattern        = "\"Checkout lock stuck\""

  metric_transformation {
    name      = "CheckoutLockStuck"
    namespace = "${local.name_prefix}/Billing"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "checkout_lock_stuck" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-checkout-lock-stuck"
  alarm_description   = "A server's checkout lock is stuck open; search app logs for \"Checkout lock stuck\" to find the guild"
  namespace           = aws_cloudwatch_log_metric_filter.checkout_lock_stuck.metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.checkout_lock_stuck.metric_transformation[0].name
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

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
  runtime       = "nodejs24.x"
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
  depends_on        = [aws_kms_key_policy.app_general]
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

