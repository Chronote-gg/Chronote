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
  AWS_TOKEN_KEY     = "mock"
  DISCORD_CLIENT_ID = "mock"
}

# Exact patterns are checked against src/metrics.ts by
# test/scripts/lifecycleAlarms.test.ts; this checks routing and conditions.
run "lifecycle_alarms_route_by_name_and_notify" {
  command = plan
  plan_options {
    target = [
      aws_cloudwatch_log_metric_filter.lifecycle,
      aws_cloudwatch_metric_alarm.lifecycle,
      aws_cloudwatch_metric_alarm.deploy_drain_timeout,
    ]
  }
  variables { alert_email = "alerts@example.com" }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lifecycle) == 6 && alltrue([for f in aws_cloudwatch_log_metric_filter.lifecycle : f.log_group_name == "/ecs/meeting-notes-prod-bot"])
    error_message = "Every lifecycle filter must read the app log group by its name."
  }

  assert {
    condition     = alltrue([for a in concat(values(aws_cloudwatch_metric_alarm.lifecycle), aws_cloudwatch_metric_alarm.deploy_drain_timeout) : a.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts"])])
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
    condition     = aws_cloudwatch_metric_alarm.deploy_drain_timeout[0].namespace == "meeting-notes-prod/Deploy" && aws_cloudwatch_metric_alarm.deploy_drain_timeout[0].metric_name == "DrainWaitTimedOut" && length(coalesce(aws_cloudwatch_metric_alarm.deploy_drain_timeout[0].dimensions, {})) == 0
    error_message = "The drain alarm must watch the dimensionless metric deploy.cjs publishes."
  }
}

run "lifecycle_alarms_follow_alerting" {
  command = plan
  plan_options {
    target = [aws_cloudwatch_metric_alarm.lifecycle, aws_cloudwatch_metric_alarm.deploy_drain_timeout]
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lifecycle) == 0 && length(aws_cloudwatch_metric_alarm.deploy_drain_timeout) == 0
    error_message = "Without an alert destination no lifecycle alarm is created."
  }
}

run "parked_environment_has_no_worker_silence_alarms" {
  command = plan
  plan_options {
    target = [aws_cloudwatch_log_metric_filter.lifecycle, aws_cloudwatch_metric_alarm.lifecycle]
  }
  variables {
    alert_email       = "alerts@example.com"
    environment       = "sandbox"
    ECS_DESIRED_COUNT = 0
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lifecycle) == 4 && length(setintersection(concat(keys(aws_cloudwatch_metric_alarm.lifecycle), keys(aws_cloudwatch_log_metric_filter.lifecycle)), ["no_eligible_worker", "finisher_scan_missing"])) == 0
    error_message = "A parked environment must keep every lifecycle alarm except the two that alarm on worker silence."
  }
}
