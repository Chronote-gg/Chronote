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
    defaults = { arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111", policy = "{}" }
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

run "deployment_prerequisites_are_scoped_without_service_changes" {
  override_resource {
    target          = aws_dynamodb_table.deployment_control_table
    override_during = plan
    values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/chronote-prod-DeploymentControlTable" }
  }
  override_resource {
    target          = aws_dynamodb_table.active_meeting_table
    override_during = plan
    values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/chronote-prod-ActiveMeetingTable" }
  }
  override_resource {
    target          = aws_dynamodb_table.meeting_history_table
    override_during = plan
    values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/chronote-prod-MeetingHistoryTable" }
  }
  override_resource {
    target          = aws_lb_listener.api_https[0]
    override_during = plan
    values          = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/test/1234567890123456/1234567890123456" }
  }
  command = plan
  plan_options {
    target = [
      aws_dynamodb_table.deployment_control_table,
      aws_lb_target_group.api_spare_tg[0],
      aws_iam_role_policy.deployment_control,
      aws_iam_policy.deployment_routing[0]
    ]
  }
  variables {
    project_name       = "chronote"
    environment        = "prod"
    github_environment = "production"
  }
  override_resource {
    target          = aws_ecs_service.app_service
    override_during = plan
    values = {
      id   = "arn:aws:ecs:us-east-1:123456789012:service/should-not-be-read/should-not-be-read"
      name = "should-not-be-read"
    }
  }
  assert {
    condition = length(jsondecode(aws_iam_role_policy.deployment_control.policy).Statement) == 3 && length([
      for s in jsondecode(aws_iam_role_policy.deployment_control.policy).Statement : s
      if toset(s.Action) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"]) && toset(s.Resource) == toset([aws_dynamodb_table.deployment_control_table.arn]) && s.Effect == "Allow"
    ]) == 1
    error_message = "Deployment control CRUD and reads must target only its table, without relying on the shared DynamoDB policy or GSI permissions."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.deployment_control.policy).Statement : s
      if toset(s.Action) == toset(["dynamodb:ConditionCheckItem"]) && toset(s.Resource) == toset([aws_dynamodb_table.deployment_control_table.arn, aws_dynamodb_table.active_meeting_table.arn, aws_dynamodb_table.meeting_history_table.arn]) && s.Effect == "Allow"
    ]) == 1
    error_message = "Condition checks must retain exactly the existing three tables."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.deployment_control.policy).Statement : s
      if toset(s.Action) == toset(["ecs:GetTaskProtection", "ecs:UpdateTaskProtection"]) && toset(s.Resource) == toset(["arn:aws:ecs:us-east-1:123456789012:task/chronote-prod-bot-cluster/*"]) && s.Effect == "Allow"
    ]) == 1
    error_message = "Native task protection permissions must remain scoped to the existing cluster."
  }
  assert {
    condition = jsondecode(aws_iam_policy.deployment_routing[0].policy).Statement == jsondecode(jsonencode([
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:ModifyListener"]
        Resource = [aws_lb_listener.api_https[0].arn]
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes",
          "elasticloadbalancing:DescribeTargetHealth"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:ListServiceDeployments"]
        Resource = "arn:aws:ecs:us-east-1:123456789012:service/chronote-prod-bot-cluster/chronote-prod-bot-service"
      },
      {
        Effect = "Allow"
        Action = ["ecs:DescribeServiceDeployments", "ecs:DescribeServiceRevisions"]
        Resource = [
          "arn:aws:ecs:us-east-1:123456789012:service/chronote-prod-bot-cluster/chronote-prod-bot-service",
          "arn:aws:ecs:us-east-1:123456789012:service-deployment/chronote-prod-bot-cluster/chronote-prod-bot-service/*",
          "arn:aws:ecs:us-east-1:123456789012:service-revision/chronote-prod-bot-cluster/chronote-prod-bot-service/*"
        ]
      }
    ]))
    error_message = "Routing must preserve exact listener scope and read actions, using service ARNs independent of the ECS service and its task definition."
  }
}

run "app_general_policy_preserves_permissions_and_key_settings" {
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
    condition     = jsondecode(aws_kms_key_policy.app_general.policy) == jsondecode(file("tests/fixtures/app-general-policy.json"))
    error_message = "The standalone policy must preserve all seven existing statements, principals, actions and CloudFront source ARNs."
  }
  assert {
    condition     = aws_kms_key_policy.app_general.key_id == aws_kms_key.app_general.id && aws_kms_key_policy.app_general.bypass_policy_lockout_safety_check != true && aws_kms_key.app_general.policy == "{}" && aws_kms_key.app_general.bypass_policy_lockout_safety_check != true && aws_kms_key.app_general.enable_key_rotation && aws_kms_key.app_general.deletion_window_in_days == 7 && aws_kms_key.app_general.description == "KMS key for ECR, CloudWatch logs, and other app resources"
    error_message = "Policy ownership must retain the existing key and key settings with lockout protection enabled."
  }
}
