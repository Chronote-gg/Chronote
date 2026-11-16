mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test-role" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111", policy = "{}" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/test" }
  }
  mock_resource "aws_appconfig_application" {
    defaults = { id = "app1234" }
  }
  mock_resource "aws_appconfig_environment" {
    defaults = { environment_id = "env1234" }
  }
  mock_resource "aws_appconfig_configuration_profile" {
    defaults = { configuration_profile_id = "prf1234" }
  }
  mock_resource "aws_appconfig_deployment_strategy" {
    defaults = { id = "str1234" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-123456" }
  }
}
mock_provider "github" {}
mock_provider "grafana" {}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  GITHUB_TOKEN         = "mock"
  DISCORD_CLIENT_ID    = "mock"
  ENABLE_ELASTICACHE   = false
  API_DOMAIN           = "api.example.test"
  DISCORD_CALLBACK_URL = "https://api.example.test/auth/discord/callback"
}

run "production_has_one_cpu_and_two_gib" {
  command = plan
  plan_options { target = [aws_ecs_task_definition.app_task] }
  assert {
    condition     = aws_ecs_task_definition.app_task.cpu == "1024" && aws_ecs_task_definition.app_task.memory == "2048"
    error_message = "Production task must reserve one vCPU and 2 GiB."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.app_task.container_definitions)[0].cpu == 1024 && jsondecode(aws_ecs_task_definition.app_task.container_definitions)[0].memory == 2048
    error_message = "Production container limits must match the task capacity."
  }
  assert {
    condition     = one(aws_ecs_task_definition.app_task.ephemeral_storage).size_in_gib == 60
    error_message = "Production task must reserve 60 GiB of ephemeral storage."
  }
}

# The disk alarms follow the reserved size: 75 and 95 percent of it, in the
# decimal GB that EphemeralStorageUtilized reports.
run "disk_alarms_follow_the_reserved_storage" {
  command = plan
  plan_options { target = [aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_leak, aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_critical] }
  variables { alert_email = "alerts@example.com" }
  assert {
    condition     = aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_leak[0].threshold == 48 && aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_critical[0].threshold == 61.2
    error_message = "Production disk alarms must sit at 75 and 95 percent of 60 GiB."
  }
}

run "sandbox_disk_alarms_keep_the_default_thresholds" {
  command = plan
  plan_options { target = [aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_leak, aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_critical] }
  variables {
    environment        = "sandbox"
    github_environment = "sandbox"
    alert_email        = "alerts@example.com"
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_leak[0].threshold == 16 && aws_cloudwatch_metric_alarm.ecs_ephemeral_storage_critical[0].threshold == 20.4
    error_message = "Sandbox disk alarms must sit at 75 and 95 percent of the 20 GiB default."
  }
}

run "sandbox_keeps_existing_capacity" {
  command = plan
  plan_options { target = [aws_ecs_task_definition.app_task] }
  variables {
    environment        = "sandbox"
    github_environment = "sandbox"
  }
  assert {
    condition     = aws_ecs_task_definition.app_task.cpu == "512" && aws_ecs_task_definition.app_task.memory == "1024"
    error_message = "Sandbox must retain half a vCPU and 1 GiB."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.app_task.container_definitions)[0].cpu == 512 && jsondecode(aws_ecs_task_definition.app_task.container_definitions)[0].memory == 1024
    error_message = "Sandbox container limits must retain their existing capacity."
  }
  assert {
    condition     = length(aws_ecs_task_definition.app_task.ephemeral_storage) == 0
    error_message = "Sandbox keeps the 20 GiB Fargate default, which costs nothing extra."
  }
}
