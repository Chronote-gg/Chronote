mock_provider "aws" {
  override_during = plan
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

run "sandbox_role_and_appconfig_are_scoped" {
  command = plan
  plan_options {
    target = [aws_iam_role.sandbox_deploy, aws_iam_policy.appconfig_access_policy]
  }
  variables {
    environment        = "sandbox"
    github_environment = "sandbox"
  }
  assert {
    condition     = length(aws_iam_role.sandbox_deploy) == 1 && aws_iam_role.sandbox_deploy[0].max_session_duration == 10800
    error_message = "Sandbox must have exactly one three-hour deployment role."
  }
  assert {
    condition     = jsondecode(aws_iam_role.sandbox_deploy[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:Chronote-gg/Chronote:environment:sandbox"
    error_message = "Trust must require the exact Sandbox subject."
  }
  assert {
    condition     = jsondecode(aws_iam_role.sandbox_deploy[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:repository_owner_id"] == "67890"
    error_message = "Trust must bind the immutable owner ID."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_policy.appconfig_access_policy.policy).Statement : s.Resource != "*"])
    error_message = "Sandbox AppConfig must not retain account-wide permissions."
  }
}

run "production_does_not_adopt_sandbox_role" {
  command = plan
  plan_options {
    target = [aws_iam_role.sandbox_deploy, aws_iam_policy.appconfig_access_policy]
  }
  variables {
    environment        = "prod"
    github_environment = "production"
  }
  assert {
    condition     = length(aws_iam_role.sandbox_deploy) == 0
    error_message = "No deployment role may be created for production."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.appconfig_access_policy.policy).Statement[0].Resource == "*"
    error_message = "This Sandbox change must preserve the existing production AppConfig policy."
  }
}
