# --- Meeting lifecycle, worker registry and deployment drain ---
# The finisher, the worker registry, task protection and renewal recovery run
# unattended in every worker, and the deploy script waits unattended for older
# tasks to drain. The application publishes a named metric for each condition
# as Embedded Metric Format lines (src/lifecycleMetrics.ts), which CloudWatch
# Logs extracts from the app log group, and the deploy script publishes one
# custom metric, so each alarm below emails the critical alerts topic. The
# alarms read the dimensionless series; test/scripts/lifecycleAlarms.test.ts
# keeps the metric names here and in the code identical.

locals {
  lifecycle_alarms = {
    meeting_lifecycle_stuck = {
      metric             = "MeetingStuck"
      threshold          = 1
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "A meeting has been unfinished for more than four hours, its Discord delivery has been pending and failing for more than an hour, or it was abandoned after 24 hours. Check the bot logs for \"Meeting lifecycle stuck\" or \"Meeting lifecycle abandoned\"."
    }
    meeting_finish_failed = {
      metric             = "MeetingFailed"
      threshold          = 1
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "A meeting reached failed after its finish retries, or its Discord delivery gave up. Check the bot logs for \"Meeting finish failed after retries\" or \"Meeting delivery failed after retries\"."
    }
    task_protection_failing = {
      # Setting protection during a capture and clearing it afterwards both
      # retry once a minute and emit this, so three failures in five
      # minutes means the calls keep failing rather than one blip.
      metric             = "TaskProtectionFailed"
      threshold          = 3
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "ECS task protection calls keep failing, either while a capture is live (a deployment or scale-in could stop a recording task) or while clearing it after the last capture (the task stays protected and blocks a drain). Check the bot logs for \"Task protection failed during capture\"."
    }
    no_eligible_worker = {
      # Each eligible worker emits this once a minute, so a healthy service
      # produces several datapoints per period and silence is the signal.
      metric             = "WorkerEligibleHeartbeat"
      threshold          = 1
      comparison         = "LessThanThreshold"
      evaluation_periods = 1
      treat_missing_data = "breaching"
      description        = "No worker has reported itself eligible for five minutes, so new meetings cannot start. Check the ECS service and the bot logs for \"Worker eligible heartbeat\"."
    }
    finisher_scan_missing = {
      # Each eligible worker emits this at most once a minute after a scan that
      # read the table through, so two silent periods mean no scan completed.
      metric             = "FinisherScanCompleted"
      threshold          = 1
      comparison         = "LessThanThreshold"
      evaluation_periods = 2
      treat_missing_data = "breaching"
      description        = "No eligible worker completed a finisher scan for ten minutes, so unfinished meetings, retries and pending deliveries are not being picked up. Also fires alongside no_eligible_worker when no worker is eligible. Check the bot logs for \"Meeting finisher scan failed\" and DynamoDB errors."
    }
    renewal_recovery_stalled = {
      # One transient lease error also emits this, so only a stall that
      # lasts three whole periods alarms.
      metric             = "RenewalRecoveryStalled"
      threshold          = 1
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 3
      treat_missing_data = "notBreaching"
      description        = "Renewal recovery has skipped its polls on lease errors for fifteen minutes, so stuck billing renewals are not being recovered. Check the bot logs for \"Renewal recovery poll skipped after a lease error\"."
    }
    speech_detector_retiring = {
      # A single hang or crash retires the child once and recovers after the
      # cooldown; three or more in every period for fifteen minutes is a loop.
      metric             = "SpeechDetectorRetired"
      threshold          = 3
      comparison         = "GreaterThanOrEqualToThreshold"
      evaluation_periods = 3
      treat_missing_data = "notBreaching"
      description        = "The speech detector killed and restarted its child three or more times in each of three five minute periods. Each retirement makes the detector unavailable for at least 30 seconds, so snippets are transcribed without the speech gate. Check the bot logs and task CPU for a hang, crash or invalid output loop."
    }
    # Both transcription guards expect zero; one 15 minute period makes the
    # threshold a sum over the whole window rather than per five minutes.
    transcription_missing_logprobs = {
      metric             = "TranscriptionMissingLogprobs"
      threshold          = 5
      comparison         = "GreaterThanThreshold"
      period             = 900
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "More than five transcription responses in fifteen minutes came back with text but no logprobs. The provider stopped returning confidence data, so the quiet-audio guard is inactive and hallucinated lines can pass into transcripts and notes. This counts the warning line \"Transcription response has no logprobs.\", logged only for a response with text; the guard's own logprobs_missing flag (quiet audio with no logprob metrics, the empty-output case) is not counted. Check those warning lines and the transcription model."
    }
    transcription_keywords_rejected = {
      metric             = "TranscriptionKeywordsRejected"
      threshold          = 5
      comparison         = "GreaterThanThreshold"
      period             = 900
      evaluation_periods = 1
      treat_missing_data = "notBreaching"
      description        = "More than five transcription requests in fifteen minutes were refused with HTTP 400 while carrying dictionary keywords and were retried without them. A server's dictionary terms are being rejected, so its dictionary spelling is silently lost from transcripts. Check the bot logs for \"Transcription keywords rejected\"."
    }
  }
  # Alarms on a heartbeat only a running worker emits.
  worker_silence_alarms = ["no_eligible_worker", "finisher_scan_missing"]
  # Namespaced per environment: sandbox and production share an account. The
  # task definition passes it to the app as METRICS_NAMESPACE.
  lifecycle_metrics_namespace = "${local.name_prefix}/Lifecycle"
}

resource "aws_cloudwatch_metric_alarm" "lifecycle" {
  # A parked environment runs no worker by design, so its silence is not an alarm.
  for_each = local.alerts_enabled ? {
    for key, alarm in local.lifecycle_alarms : key => alarm
    if !contains(local.worker_silence_alarms, key) || var.ECS_DESIRED_COUNT > 0
  } : {}
  alarm_name          = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  alarm_description   = each.value.description
  namespace           = local.lifecycle_metrics_namespace
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = try(each.value.period, 300)
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.evaluation_periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = each.value.treat_missing_data

  # ARN built from the topic name, not a reference: the topic depends on the KMS
  # key policy, so a reference would order every alarm after it.
  alarm_actions = [local.critical_alerts_topic_arn]
  ok_actions    = [local.critical_alerts_topic_arn]

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# The detector counts every assessment result and every unavailable one; the
# share is the signal, since a slow detector opens a breaker but no longer retires.
# Healthy days run at 0 to 2 percent unavailable. Periods with fewer than 50
# assessments score 0, so a quiet hour cannot trip it.
resource "aws_cloudwatch_metric_alarm" "speech_detector_unavailable_share" {
  count               = local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-speech-detector-unavailable-share"
  alarm_description   = "More than 20 percent of speech assessments were unavailable in each of two 15 minute periods with at least 50 assessments. Those snippets are transcribed without the speech gate. Check task CPU and the SpeechDetectorRetired alarm; persistently slow inference opens a breaker that refuses work rather than retiring the child."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.2
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "share"
    expression  = "IF(attempted >= 50, FILL(unavailable, 0) / attempted, 0)"
    label       = "Unavailable share of speech assessments"
    return_data = true
  }
  metric_query {
    id = "attempted"
    metric {
      namespace   = local.lifecycle_metrics_namespace
      metric_name = "SpeechAssessmentAttempted"
      period      = 900
      stat        = "Sum"
    }
  }
  metric_query {
    id = "unavailable"
    metric {
      namespace   = local.lifecycle_metrics_namespace
      metric_name = "SpeechAssessmentUnavailable"
      period      = 900
      stat        = "Sum"
    }
  }

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
