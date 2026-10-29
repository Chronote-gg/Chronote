# --- OpenAI: requests rejected for quota, credits, or rate limit ---
# When the OpenAI org runs dry or is throttled, transcription and notes calls
# fail while the bot stays healthy and the meeting still saves, so no other
# alarm fires. The only symptom is "Notes could not be generated" or a partial
# transcript on each affected meeting. Snippet failures log only the HTTP
# status, so the pattern matches the status as well as the quota messages.

resource "aws_cloudwatch_log_metric_filter" "openai_requests_rejected" {
  count          = local.alerts_enabled ? 1 : 0
  name           = "${local.name_prefix}-openai-requests-rejected"
  log_group_name = aws_cloudwatch_log_group.app_log_group.name
  pattern        = "?\"insufficient_quota\" ?\"no credits remaining\" ?\"exceeded your current quota\" ?\"RateLimitError\" ?\"status: 429\""

  metric_transformation {
    # Namespaced per environment: sandbox and production share an account.
    namespace = "${local.name_prefix}/Logs"
    name      = "OpenAIRequestsRejected"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "openai_requests_rejected" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-openai-requests-rejected"
  alarm_description   = "OpenAI is rejecting requests (out of credits, quota, or rate limited). Transcription and notes are failing; check OpenAI billing and limits."
  namespace           = aws_cloudwatch_log_metric_filter.openai_requests_rejected[0].metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.openai_requests_rejected[0].metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
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
