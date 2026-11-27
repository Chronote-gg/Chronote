mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111", policy = "{}" }
  }
}
mock_provider "github" {}
mock_provider "grafana" {}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  GITHUB_TOKEN       = "mock"
  DISCORD_CLIENT_ID  = "mock"
  ENABLE_ELASTICACHE = false
  ENABLE_API_ALB     = true
  API_DOMAIN         = "api.example.test"
  API_CERT_ARN       = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  alert_email        = "alerts@example.com"
}

# Alarm notifications failed for months because this statement carried a
# kms:CallerAccount condition, which never matches a service principal.
run "key_policy_lets_alarms_use_the_topic_key" {
  command = plan
  plan_options { target = [aws_kms_key_policy.app_general] }
  override_resource {
    target          = aws_cloudfront_distribution.frontend
    override_during = plan
    values          = { id = "FRONTEND-TEST" }
  }
  override_resource {
    target          = aws_cloudfront_distribution.docs
    override_during = plan
    values          = { id = "DOCS-TEST" }
  }

  assert {
    condition = length([
      for s in jsondecode(aws_kms_key_policy.app_general.policy).Statement : s
      if s.Effect == "Allow"
      && contains(flatten([try(s.Principal.Service, [])]), "cloudwatch.amazonaws.com")
      && length(setsubtract(["kms:Decrypt", "kms:GenerateDataKey*"], flatten([s.Action]))) == 0
      && !contains(keys(merge(values(try(s.Condition, {}))...)), "kms:CallerAccount")
      && try(s.Condition.StringEquals["kms:EncryptionContext:aws:sns:topicArn"], "") == "arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts"
    ]) == 1
    error_message = "Exactly one statement must let cloudwatch.amazonaws.com Decrypt and GenerateDataKey* for the critical alerts topic, without kms:CallerAccount."
  }
}

run "every_alarm_notifies_the_critical_topic" {
  command = plan
  plan_options {
    target = [
      aws_cloudwatch_metric_alarm.ecs_no_running_tasks,
      aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_leak,
      aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_critical,
      aws_cloudwatch_metric_alarm.alb_5xx_errors,
      aws_cloudwatch_metric_alarm.alb_elb_5xx_errors,
      aws_cloudwatch_metric_alarm.alb_elb_5xx_sustained,
      aws_cloudwatch_metric_alarm.alb_unhealthy_hosts,
      aws_cloudwatch_metric_alarm.checkout_lock_stuck,
      aws_cloudwatch_metric_alarm.lifecycle,
      aws_cloudwatch_metric_alarm.deploy_drain_timeout,
      aws_cloudwatch_metric_alarm.openai_requests_rejected,
      aws_cloudwatch_metric_alarm.processing_retry_worker_failed,
      aws_cloudwatch_metric_alarm.voice_settlement_unresolved,
      aws_cloudwatch_metric_alarm.voice_admission_blocked,
    ]
  }

  assert {
    condition = alltrue([
      for a in concat(
        aws_cloudwatch_metric_alarm.ecs_no_running_tasks,
        aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_leak,
        aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_critical,
        aws_cloudwatch_metric_alarm.alb_5xx_errors,
        aws_cloudwatch_metric_alarm.alb_elb_5xx_errors,
        aws_cloudwatch_metric_alarm.alb_elb_5xx_sustained,
        values(aws_cloudwatch_metric_alarm.alb_unhealthy_hosts),
        aws_cloudwatch_metric_alarm.checkout_lock_stuck,
        values(aws_cloudwatch_metric_alarm.lifecycle),
        aws_cloudwatch_metric_alarm.deploy_drain_timeout,
        aws_cloudwatch_metric_alarm.openai_requests_rejected,
        aws_cloudwatch_metric_alarm.processing_retry_worker_failed,
        aws_cloudwatch_metric_alarm.voice_settlement_unresolved,
        aws_cloudwatch_metric_alarm.voice_admission_blocked,
      ) :
      a.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts"])
      && a.ok_actions == toset(["arn:aws:sns:us-east-1:123456789012:meeting-notes-prod-critical-alerts"])
    ])
    error_message = "Every alarm must send both ALARM and OK to the critical alerts topic."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.ecs_no_running_tasks) == 1 && length(aws_cloudwatch_metric_alarm.alb_elb_5xx_sustained) == 1 && length(aws_cloudwatch_metric_alarm.lifecycle) > 0
    error_message = "The alarms under test must exist in this configuration, or the check above is vacuous."
  }
}
