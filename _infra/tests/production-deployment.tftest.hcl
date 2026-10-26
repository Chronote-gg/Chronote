override_resource {
  target          = aws_dynamodb_table.active_meeting_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/active_meeting_table" }
}
override_resource {
  target          = aws_dynamodb_table.meeting_history_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/meeting_history_table" }
}
override_resource {
  target          = aws_dynamodb_table.meeting_control_command_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/meeting_control_command_table" }
}
override_resource {
  target          = aws_dynamodb_table.personal_media_upload_job_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/personal_media_upload_job_table" }
}
override_resource {
  target          = aws_dynamodb_table.personal_recording_segment_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/personal_recording_segment_table" }
}
override_resource {
  target          = aws_dynamodb_table.guild_subscription_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/guild_subscription_table" }
}
override_resource {
  target          = aws_dynamodb_table.stripe_webhook_event_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/stripe_webhook_event_table" }
}
override_resource {
  target          = aws_dynamodb_table.payment_transaction_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/payment_transaction_table" }
}
override_resource {
  target          = aws_dynamodb_table.deployment_control_table
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/deployment_control_table" }
}
override_resource {
  target          = aws_iam_role.ecs_task_app_role
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/ecs_task_app_role" }
}
override_resource {
  target          = aws_iam_role.ecs_task_execution_role
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/ecs_task_execution_role" }
}
mock_provider "aws" {
  override_during = plan
  mock_resource "aws_ecs_service" {
    defaults = { id = "arn:aws:ecs:us-east-1:123456789012:service/meeting-notes-prod-bot-cluster/meeting-notes-prod-bot-service" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/meeting-notes-prod-bot-cluster" }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/mock-table" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock-policy" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/mock-repository" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-secret-123456" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/mock/1234567890123456/1234567890123456" }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/test/1234567890123456" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/test/1234567890123456" }
  }
  mock_resource "aws_appconfig_application" {
    defaults = { id = "app1234", arn = "arn:aws:appconfig:us-east-1:123456789012:application/app1234" }
  }
  mock_resource "aws_appconfig_configuration_profile" {
    defaults = { configuration_profile_id = "prf1234", arn = "arn:aws:appconfig:us-east-1:123456789012:application/app1234/configurationprofile/prf1234" }
  }
  mock_resource "aws_appconfig_environment" {
    defaults = { environment_id = "env1234", arn = "arn:aws:appconfig:us-east-1:123456789012:application/app1234/environment/env1234" }
  }
  mock_resource "aws_appconfig_deployment_strategy" {
    defaults = { id = "str1234", arn = "arn:aws:appconfig:us-east-1:123456789012:deploymentstrategy/str1234" }
  }

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
    defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111" }
  }
}
mock_provider "github" {
  mock_data "github_repository" {
    defaults = { repo_id = 12345, name = "Chronote" }
  }
  mock_data "github_organization" {
    defaults = { id = "67890" }
  }
}
mock_provider "grafana" {}
mock_provider "random" {}
mock_provider "archive" {}

variables {
  GITHUB_TOKEN       = "mock"
  AWS_TOKEN_KEY      = "mock"
  DISCORD_CLIENT_ID  = "mock"
  ENABLE_ELASTICACHE = false
  ENABLE_API_ALB     = true
  API_DOMAIN         = "sandbox.example.test"
  API_CERT_ARN       = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
}

run "production_identity_and_permissions" {
  command = plan
  plan_options {
    target = [aws_iam_role_policy.production_deploy, aws_iam_role_policy.production_exec_channels, aws_iam_role_policy_attachment.production_deploy_routing, github_actions_environment_variable.production_deploy_role, github_actions_environment_variable.production_deploy_account]
  }
  variables {
    environment        = "prod"
    github_environment = "production"
  }
  assert {
    condition     = jsondecode(aws_iam_role.production_deploy[0].assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "Trust must bind the provider in the deployment account."
  }
  assert {
    condition = tomap(jsondecode(aws_iam_role.production_deploy[0].assume_role_policy).Statement[0].Condition.StringEquals) == tomap({
      "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
      "token.actions.githubusercontent.com:sub"                 = "repo:Chronote-gg/Chronote:environment:production"
      "token.actions.githubusercontent.com:repository_id"       = "12345"
      "token.actions.githubusercontent.com:repository_owner_id" = "67890"
      "token.actions.githubusercontent.com:ref"                 = "refs/heads/master"
    })
    error_message = "Only the exact production repository, owner, environment and master ref may assume."
  }
  assert {
    condition     = alltrue([for claim in ["repo:Chronote-gg/Chronote:environment:sandbox", "repo:foreign/Chronote:environment:production", "repo:Chronote-gg/Chronote:ref:refs/heads/master"] : claim != jsondecode(aws_iam_role.production_deploy[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]]) && alltrue([for ref in ["refs/heads/codex/repair", "refs/tags/master", "refs/heads/main"] : ref != jsondecode(aws_iam_role.production_deploy[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"]])
    error_message = "Foreign environments, repositories, topic branches and tags must fail exact trust."
  }
  assert {
    condition     = length(jsondecode(aws_iam_role.production_deploy[0].assume_role_policy).Statement) == 1 && keys(jsondecode(aws_iam_role.production_deploy[0].assume_role_policy).Statement[0].Condition) == ["StringEquals"]
    error_message = "No alternative or wildcard production trust is allowed."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_deploy[0].policy).Statement : s.Resource if s.Sid == "ProductionService"]) == aws_ecs_service.app_service.id
    error_message = "Service writes must bind only the existing service."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_deploy[0].policy).Statement : s.Resource if s.Sid == "RuntimeAdmissionFence"]) == aws_iam_role.ecs_task_app_role.arn
    error_message = "Fence writes must bind only the existing runtime role."
  }
  assert {
    condition     = toset(one([for s in jsondecode(aws_iam_role_policy.production_deploy[0].policy).Statement : s.Resource if s.Sid == "PassOnlyProductionRuntimeRoles"])) == toset([aws_iam_role.ecs_task_app_role.arn, aws_iam_role.ecs_task_execution_role.arn]) && one([for s in jsondecode(aws_iam_role_policy.production_deploy[0].policy).Statement : s.Condition.StringEquals["iam:PassedToService"] if s.Sid == "PassOnlyProductionRuntimeRoles"]) == "ecs-tasks.amazonaws.com"
    error_message = "PassRole must bind only the two existing ECS roles and ECS tasks."
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.production_deploy[0].policy).Statement : s.Resource if s.Sid == "DeploymentControlProtocol"]) == aws_dynamodb_table.deployment_control_table.arn
    error_message = "Receipts must reuse the existing deployment control table."
  }
  assert {
    condition     = toset(one([for s in jsondecode(aws_iam_role_policy.production_deploy[0].policy).Statement : s.Resource if s.Sid == "ProductionObservationAndPreflight"])) == toset([aws_dynamodb_table.active_meeting_table.arn, aws_dynamodb_table.meeting_history_table.arn, aws_dynamodb_table.meeting_control_command_table.arn, aws_dynamodb_table.personal_media_upload_job_table.arn, aws_dynamodb_table.personal_recording_segment_table.arn, aws_dynamodb_table.guild_subscription_table.arn, aws_dynamodb_table.stripe_webhook_event_table.arn, aws_dynamodb_table.payment_transaction_table.arn])
    error_message = "Observation must bind the eight reviewed existing tables."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.deployment_routing[0].policy).Statement[0].Resource == [aws_lb_listener.api_https[0].arn] && aws_iam_role_policy_attachment.production_deploy_routing[0].policy_arn == aws_iam_policy.deployment_routing[0].arn
    error_message = "Routing must reuse the policy for the exact existing HTTPS listener."
  }
  assert {
    condition     = aws_iam_role_policy.production_exec_channels[0].role == aws_iam_role.ecs_task_app_role.id && toset(jsondecode(aws_iam_role_policy.production_exec_channels[0].policy).Statement[0].Action) == toset(["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]) && jsondecode(aws_iam_role_policy.production_exec_channels[0].policy).Statement[0].Resource == "*"
    error_message = "Only the four resource-unscopable channel actions belong on the runtime role."
  }
  assert {
    condition     = github_actions_environment_variable.production_deploy_role[0].variable_name == "PRODUCTION_BACKEND_DEPLOY_ROLE_ARN" && github_actions_environment_variable.production_deploy_role[0].value == aws_iam_role.production_deploy[0].arn && github_actions_environment_variable.production_deploy_account[0].value == "123456789012"
    error_message = "Actions variables must expose the exact production role and account."
  }
}
run "sandbox_does_not_adopt_production_authority" {
  command = plan
  plan_options {
    target = [aws_iam_role.production_deploy, aws_iam_role_policy.production_exec_channels]
  }
  variables {
    environment        = "sandbox"
    github_environment = "sandbox"
  }
  assert {
    condition     = length(aws_iam_role.production_deploy) == 0 && length(aws_iam_role_policy.production_exec_channels) == 0
    error_message = "Production role and runtime channels must not change Sandbox."
  }
}
run "production_refuses_foreign_github_environment" {
  command = plan
  plan_options {
    target = [aws_iam_role.production_deploy]
  }
  variables {
    environment        = "prod"
    github_environment = "sandbox"
  }
  expect_failures = [aws_iam_role.production_deploy]
}
