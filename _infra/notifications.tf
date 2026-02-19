# -----------------------------------------------------------------------
# Critical alerts: SNS topic, email subscription, and CloudWatch alarms
# -----------------------------------------------------------------------

variable "alert_email" {
  description = "Email address for critical alert notifications (requires manual confirmation after first apply)"
  type        = string
  default     = ""
}

locals {
  alerts_enabled = var.alert_email != ""
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
  count     = local.alerts_enabled ? 1 : 0
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
  alarm_name          = "${local.name_prefix}-alb-5xx-errors"
  alarm_description   = "ALB returning elevated 5xx errors"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
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
