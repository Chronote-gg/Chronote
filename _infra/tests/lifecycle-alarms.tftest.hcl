mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}
mock_provider "github" {}
mock_provider "grafana" {}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  GITHUB_TOKEN      = "mock"
  DISCORD_CLIENT_ID = "mock"
}

# Metric names are checked against src/lifecycleMetrics.ts by
# test/scripts/lifecycleAlarms.test.ts; this checks routing and conditions.
run "lifecycle_alarms_route_by_name_and_notify" {
  command = plan
  plan_options {
    target = [
      aws_cloudwatch_metric_alarm.lifecycle,
      aws_cloudwatch_metric_alarm.deploy_drain_timeout,
      aws_cloudwatch_metric_alarm.speech_detector_unavailable_share,
    ]
  }
  variables { alert_email = "alerts@example.com" }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lifecycle) == 11 && alltrue([for a in values(aws_cloudwatch_metric_alarm.lifecycle) : a.namespace == "meeting-notes-prod/Lifecycle" && length(coalesce(a.dimensions, {})) == 0 && a.statistic == "Sum"])
    error_message = "Every lifecycle alarm must sum the dimensionless metric in the environment's Lifecycle namespace."
  }

  assert {
    condition     = alltrue([for a in concat(values(aws_cloudwatch_metric_alarm.lifecycle), aws_cloudwatch_metric_alarm.deploy_drain_timeout, aws_cloudwatch_metric_alarm.speech_detector_unavailable_share) : a.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts"])])
    error_message = "Every lifecycle alarm must notify through the critical alerts topic."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lifecycle["no_eligible_worker"].comparison_operator == "LessThanThreshold" && aws_cloudwatch_metric_alarm.lifecycle["no_eligible_worker"].treat_missing_data == "breaching"
    error_message = "Silence from the eligible heartbeat must alarm."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lifecycle["finisher_scan_missing"].comparison_operator == "LessThanThreshold" && aws_cloudwatch_metric_alarm.lifecycle["finisher_scan_missing"].threshold == 1 && aws_cloudwatch_metric_alarm.lifecycle["finisher_scan_missing"].evaluation_periods == 2 && aws_cloudwatch_metric_alarm.lifecycle["finisher_scan_missing"].datapoints_to_alarm == 2 && aws_cloudwatch_metric_alarm.lifecycle["finisher_scan_missing"].treat_missing_data == "breaching"
    error_message = "Ten minutes without a completed finisher scan must alarm."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lifecycle["renewal_recovery_stalled"].evaluation_periods == 3 && aws_cloudwatch_metric_alarm.lifecycle["renewal_recovery_stalled"].datapoints_to_alarm == 3 && aws_cloudwatch_metric_alarm.lifecycle["renewal_recovery_stalled"].treat_missing_data == "notBreaching"
    error_message = "Renewal recovery must alarm only on a stall across three whole periods."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lifecycle["transcription_slow_pass_rejected"].threshold == 1 && aws_cloudwatch_metric_alarm.lifecycle["transcription_slow_pass_rejected"].comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.lifecycle["transcription_slow_pass_rejected"].period == 300 && aws_cloudwatch_metric_alarm.lifecycle["transcription_slow_pass_rejected"].evaluation_periods == 1 && aws_cloudwatch_metric_alarm.lifecycle["transcription_slow_pass_rejected"].treat_missing_data == "notBreaching"
    error_message = "One refused slow-pass snippet must alarm."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lifecycle["meeting_summary_dropped"].threshold == 3 && aws_cloudwatch_metric_alarm.lifecycle["meeting_summary_dropped"].comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.lifecycle["meeting_summary_dropped"].period == 3600 && aws_cloudwatch_metric_alarm.lifecycle["meeting_summary_dropped"].evaluation_periods == 1 && aws_cloudwatch_metric_alarm.lifecycle["meeting_summary_dropped"].treat_missing_data == "notBreaching"
    error_message = "Three dropped summaries in an hour must alarm."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lifecycle["speech_detector_retiring"].threshold == 3 && aws_cloudwatch_metric_alarm.lifecycle["speech_detector_retiring"].comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.lifecycle["speech_detector_retiring"].period == 300 && aws_cloudwatch_metric_alarm.lifecycle["speech_detector_retiring"].evaluation_periods == 3 && aws_cloudwatch_metric_alarm.lifecycle["speech_detector_retiring"].datapoints_to_alarm == 3 && aws_cloudwatch_metric_alarm.lifecycle["speech_detector_retiring"].treat_missing_data == "notBreaching"
    error_message = "The detector alarm must fire on three or more retirements in each of three five minute periods."
  }

  assert {
    condition     = alltrue([for key in ["transcription_missing_logprobs", "transcription_keywords_rejected"] : aws_cloudwatch_metric_alarm.lifecycle[key].period == 900 && aws_cloudwatch_metric_alarm.lifecycle[key].evaluation_periods == 1 && aws_cloudwatch_metric_alarm.lifecycle[key].threshold == 5 && aws_cloudwatch_metric_alarm.lifecycle[key].comparison_operator == "GreaterThanThreshold" && aws_cloudwatch_metric_alarm.lifecycle[key].treat_missing_data == "notBreaching"])
    error_message = "Each transcription guard must alarm on more than five events summed over one fifteen minute period."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.speech_detector_unavailable_share[0].threshold == 0.2 && aws_cloudwatch_metric_alarm.speech_detector_unavailable_share[0].comparison_operator == "GreaterThanThreshold" && aws_cloudwatch_metric_alarm.speech_detector_unavailable_share[0].evaluation_periods == 2 && aws_cloudwatch_metric_alarm.speech_detector_unavailable_share[0].datapoints_to_alarm == 2 && aws_cloudwatch_metric_alarm.speech_detector_unavailable_share[0].treat_missing_data == "notBreaching" && length([for q in aws_cloudwatch_metric_alarm.speech_detector_unavailable_share[0].metric_query : q if q.expression == "IF(attempted >= 50, FILL(unavailable, 0) / attempted, 0)" && q.return_data == true]) == 1 && alltrue([for q in aws_cloudwatch_metric_alarm.speech_detector_unavailable_share[0].metric_query : alltrue([for m in q.metric : m.namespace == "meeting-notes-prod/Lifecycle" && m.period == 900 && m.stat == "Sum"])])
    error_message = "The unavailable share alarm must fire above 20 percent in two 15 minute periods with at least 50 assessments."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.deploy_drain_timeout[0].namespace == "meeting-notes-prod/Deploy" && aws_cloudwatch_metric_alarm.deploy_drain_timeout[0].metric_name == "DrainWaitTimedOut" && length(coalesce(aws_cloudwatch_metric_alarm.deploy_drain_timeout[0].dimensions, {})) == 0
    error_message = "The drain alarm must watch the dimensionless metric deploy.cjs publishes."
  }
}

run "lifecycle_alarms_follow_alerting" {
  command = plan
  plan_options {
    target = [aws_cloudwatch_metric_alarm.lifecycle, aws_cloudwatch_metric_alarm.deploy_drain_timeout, aws_cloudwatch_metric_alarm.speech_detector_unavailable_share]
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lifecycle) == 0 && length(aws_cloudwatch_metric_alarm.deploy_drain_timeout) == 0 && length(aws_cloudwatch_metric_alarm.speech_detector_unavailable_share) == 0
    error_message = "Without an alert destination no lifecycle alarm is created."
  }
}

run "parked_environment_has_no_worker_silence_alarms" {
  command = plan
  plan_options {
    target = [aws_cloudwatch_metric_alarm.lifecycle]
  }
  variables {
    alert_email       = "alerts@example.com"
    environment       = "sandbox"
    ECS_DESIRED_COUNT = 0
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lifecycle) == 9 && length(setintersection(keys(aws_cloudwatch_metric_alarm.lifecycle), ["no_eligible_worker", "finisher_scan_missing"])) == 0
    error_message = "A parked environment must keep every lifecycle alarm except the two that alarm on worker silence."
  }
}
