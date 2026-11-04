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

# Like the processing retry worker alarm, the voice filters and alarms name the
# log group and topic rather than referencing them, which keeps the KMS key
# policy out of a voice targeted plan. The ALB alarms cannot be asserted the same
# way: their dimensions are load balancer and target group ARN suffixes, which are
# unknown under a mocked provider.
run "voice_filters_match_plain_text_and_route_by_name" {
  command = plan
  plan_options {
    target = [
      aws_cloudwatch_log_metric_filter.voice_settlement_unresolved[0],
      aws_cloudwatch_metric_alarm.voice_settlement_unresolved[0],
      aws_cloudwatch_log_metric_filter.voice_admission_blocked[0],
      aws_cloudwatch_metric_alarm.voice_admission_blocked[0],
    ]
  }
  variables { alert_email = "alerts@example.com" }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.voice_settlement_unresolved[0].log_group_name == "/ecs/meeting-notes-prod-bot" && aws_cloudwatch_log_metric_filter.voice_admission_blocked[0].log_group_name == "/ecs/meeting-notes-prod-bot"
    error_message = "Both voice filters must read the app log group by its name."
  }

  assert {
    # Plain-text console output, so each pattern is a quoted substring and not a
    # JSON selector, and must stay byte-identical to the thrown error message.
    condition     = aws_cloudwatch_log_metric_filter.voice_settlement_unresolved[0].pattern == "\"Meeting voice or lease release remains unresolved\"" && aws_cloudwatch_log_metric_filter.voice_admission_blocked[0].pattern == "\"Voice session admission blocked: voice_uncertain\""
    error_message = "Voice filter patterns must match the app's thrown error text as quoted substrings."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.voice_settlement_unresolved[0].alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts"]) && aws_cloudwatch_metric_alarm.voice_admission_blocked[0].alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts"])
    error_message = "Both voice alarms must notify through the existing critical alerts topic."
  }

  assert {
    # One occurrence is individually significant, so the alarm fires on a single
    # period rather than waiting for a rate to build.
    condition     = aws_cloudwatch_metric_alarm.voice_settlement_unresolved[0].threshold == 1 && aws_cloudwatch_metric_alarm.voice_settlement_unresolved[0].evaluation_periods == 1 && aws_cloudwatch_metric_alarm.voice_admission_blocked[0].threshold == 1 && aws_cloudwatch_metric_alarm.voice_admission_blocked[0].evaluation_periods == 1
    error_message = "Voice alarms must fire on a single occurrence in one period."
  }
}
