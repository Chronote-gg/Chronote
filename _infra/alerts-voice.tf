# --- Voice: a meeting the voice path could not settle or admit ---
# Neither line moves an ECS, ALB or OpenAI metric, so without these filters the
# only symptom is a single meeting that never finishes or never starts, visible
# to the one server that hit it and to nobody else. Both are thrown error
# messages, so the alarm text points at the log line rather than trying to carry
# the guild. One occurrence is individually significant, so both alarms fire on a
# single hit in one period instead of waiting for a rate to build.

resource "aws_cloudwatch_log_metric_filter" "voice_settlement_unresolved" {
  count = local.alerts_enabled ? 1 : 0
  name  = "${local.name_prefix}-voice-settlement-unresolved"
  # By name, not reference: the log group depends on the KMS key policy, and a
  # reference would pull that policy into every voice scoped plan.
  log_group_name = local.app_log_group_name
  pattern        = "\"Meeting voice or lease release remains unresolved\""

  metric_transformation {
    # Namespaced per environment: sandbox and production share an account.
    namespace = "${local.name_prefix}/Logs"
    name      = "VoiceSettlementUnresolved"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "voice_settlement_unresolved" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-voice-settlement-unresolved"
  alarm_description   = "A meeting finished without releasing its voice session or lease. Search app logs for \"Meeting voice or lease release remains unresolved\"."
  namespace           = aws_cloudwatch_log_metric_filter.voice_settlement_unresolved[0].metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.voice_settlement_unresolved[0].metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  # ARN built from the topic name, not a reference, for the same reason.
  alarm_actions = [local.critical_alerts_topic_arn]
  ok_actions    = [local.critical_alerts_topic_arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_metric_filter" "voice_admission_blocked" {
  count          = local.alerts_enabled ? 1 : 0
  name           = "${local.name_prefix}-voice-admission-blocked"
  log_group_name = local.app_log_group_name
  pattern        = "\"Voice session admission blocked: voice_uncertain\""

  metric_transformation {
    namespace = "${local.name_prefix}/Logs"
    name      = "VoiceAdmissionBlocked"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "voice_admission_blocked" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-voice-admission-blocked"
  alarm_description   = "A recording was refused because the previous runtime's voice state is still uncertain. Search app logs for \"Voice session admission blocked: voice_uncertain\"."
  namespace           = aws_cloudwatch_log_metric_filter.voice_admission_blocked[0].metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.voice_admission_blocked[0].metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [local.critical_alerts_topic_arn]
  ok_actions    = [local.critical_alerts_topic_arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}
