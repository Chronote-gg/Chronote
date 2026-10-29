# --- Processing retry worker: unexpected worker failures ---
# The retry worker runs unattended in the API runtime, so a crash in its poll,
# claim or save path would otherwise leave queued retries stuck with nobody
# told. Individual job failures are not alarmed: during an OpenAI outage they
# are expected, and openai_requests_rejected already covers that case.

resource "aws_cloudwatch_log_metric_filter" "processing_retry_worker_failed" {
  count          = local.alerts_enabled ? 1 : 0
  name           = "${local.name_prefix}-processing-retry-worker-failed"
  log_group_name = aws_cloudwatch_log_group.app_log_group.name
  pattern        = "\"Processing retry worker failed\""

  metric_transformation {
    # Namespaced per environment: sandbox and production share an account.
    namespace = "${local.name_prefix}/Logs"
    name      = "ProcessingRetryWorkerFailed"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "processing_retry_worker_failed" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-processing-retry-worker-failed"
  alarm_description   = "The meeting processing retry worker hit an unexpected failure. Queued retries may be stuck; check the API runtime logs for \"Processing retry worker failed\"."
  namespace           = aws_cloudwatch_log_metric_filter.processing_retry_worker_failed[0].metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.processing_retry_worker_failed[0].metric_transformation[0].name
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
