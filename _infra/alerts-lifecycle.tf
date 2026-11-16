# --- Meeting lifecycle, worker registry and deployment drain ---
# The finisher, the worker registry, task protection and renewal recovery run
# unattended in every worker, and the deploy script waits unattended for older
# tasks to drain. The application logs a fixed line for each condition (the
# *_LOG constants in src/metrics.ts) and the deploy script publishes one custom
# metric, so each alarm below emails the critical alerts topic.
#
# Patterns use the unstructured filter syntax: the app logs plain console text,
# so each quoted term matches as a substring and `?` joins alternatives. Every
# quoted string must stay byte-identical to its constant in src/metrics.ts;
# test/scripts/lifecycleAlarms.test.ts enforces that.

locals {
  lifecycle_log_alarms = {
    meeting_lifecycle_stuck = {
      pattern            = "?\"Meeting lifecycle stuck\" ?\"Meeting lifecycle abandoned\""
      metric             = "MeetingLifecycleStuck"
      threshold          = 1
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "A meeting has been unfinished for more than four hours, or was abandoned after 24 hours. Check the bot logs for \"Meeting lifecycle stuck\" or \"Meeting lifecycle abandoned\"."
    }
    meeting_finish_failed = {
      pattern            = "?\"Meeting finish failed after retries\" ?\"Meeting delivery failed after retries\""
      metric             = "MeetingFinishFailed"
      threshold          = 1
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "A meeting reached failed after its finish retries, or its Discord delivery gave up. Check the bot logs for \"Meeting finish failed after retries\" or \"Meeting delivery failed after retries\"."
    }
    task_protection_failing = {
      # Setting protection during a capture and clearing it afterwards both
      # retry once a minute and log this line, so three failures in five
      # minutes means the calls keep failing rather than one blip.
      pattern            = "\"Task protection failed during capture\""
      metric             = "TaskProtectionFailed"
      threshold          = 3
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "ECS task protection calls keep failing, either while a capture is live (a deployment or scale-in could stop a recording task) or while clearing it after the last capture (the task stays protected and blocks a drain). Check the bot logs for \"Task protection failed during capture\"."
    }
    no_eligible_worker = {
      # Each eligible worker logs this once a minute, so a healthy service
      # produces several datapoints per period and silence is the signal.
      pattern            = "\"Worker eligible heartbeat\""
      metric             = "WorkerEligibleHeartbeat"
      threshold          = 1
      comparison         = "LessThanThreshold"
      evaluation_periods = 1
      treat_missing_data = "breaching"
      description        = "No worker has reported itself eligible for five minutes, so new meetings cannot start. Check the ECS service and the bot logs for \"Worker eligible heartbeat\"."
    }
    finisher_scan_missing = {
      # Each eligible worker logs this at most once a minute after a scan that
      # read the table through, so two silent periods mean no scan completed.
      pattern            = "\"Meeting finisher scan completed\""
      metric             = "MeetingFinisherScanCompleted"
      threshold          = 1
      comparison         = "LessThanThreshold"
      evaluation_periods = 2
      treat_missing_data = "breaching"
      description        = "No eligible worker completed a finisher scan for ten minutes, so unfinished meetings, retries and pending deliveries are not being picked up. Also fires alongside no_eligible_worker when no worker is eligible. Check the bot logs for \"Meeting finisher scan failed\" and DynamoDB errors."
    }
    renewal_recovery_stalled = {
      # One transient lease error also logs this line, so only a stall that
      # lasts three whole periods alarms.
      pattern            = "\"Renewal recovery poll skipped after a lease error\""
      metric             = "RenewalRecoveryStalled"
      threshold          = 1
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 3
      treat_missing_data = "notBreaching"
      description        = "Renewal recovery has skipped its polls on lease errors for fifteen minutes, so stuck billing renewals are not being recovered. Check the bot logs for \"Renewal recovery poll skipped after a lease error\"."
    }
  }
  # Alarms on a line only a running worker logs.
  worker_silence_alarms = ["no_eligible_worker", "finisher_scan_missing"]
}

resource "aws_cloudwatch_log_metric_filter" "lifecycle" {
  # A parked environment runs no worker by design, so its silence is not an alarm.
  for_each = local.alerts_enabled ? {
    for key, alarm in local.lifecycle_log_alarms : key => alarm
    if !contains(local.worker_silence_alarms, key) || var.ECS_DESIRED_COUNT > 0
  } : {}
  name = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  # By name, not reference: the log group depends on the KMS key policy, and a
  # reference would pull that policy into every processing-retry scoped plan.
  log_group_name = local.app_log_group_name
  pattern        = each.value.pattern

  metric_transformation {
    # Namespaced per environment: sandbox and production share an account.
    namespace = "${local.name_prefix}/Logs"
    name      = each.value.metric
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "lifecycle" {
  for_each            = aws_cloudwatch_log_metric_filter.lifecycle
  alarm_name          = each.value.name
  alarm_description   = local.lifecycle_log_alarms[each.key].description
  namespace           = each.value.metric_transformation[0].namespace
  metric_name         = each.value.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = local.lifecycle_log_alarms[each.key].evaluation_periods
  datapoints_to_alarm = local.lifecycle_log_alarms[each.key].evaluation_periods
  threshold           = local.lifecycle_log_alarms[each.key].threshold
  comparison_operator = local.lifecycle_log_alarms[each.key].comparison
  treat_missing_data  = local.lifecycle_log_alarms[each.key].treat_missing_data

  # ARN built from the topic name, not a reference: the topic depends on the KMS
  # key policy, and a reference would pull that policy into scoped plans.
  alarm_actions = [local.critical_alerts_topic_arn]
  ok_actions    = [local.critical_alerts_topic_arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# Published by scripts/deployment/deploy.cjs (wait-drain) with no dimensions,
# under SECRETS_PREFIX, which Terraform sets to local.name_prefix.
resource "aws_cloudwatch_metric_alarm" "deploy_drain_timeout" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-deploy-drain-timeout"
  alarm_description   = "A backend deployment waited the full 160 minutes for older tasks to drain and failed. An older task is still running; check the ECS service and the failed deploy run."
  namespace           = "${local.name_prefix}/Deploy"
  metric_name         = "DrainWaitTimedOut"
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
