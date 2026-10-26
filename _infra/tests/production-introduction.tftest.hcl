mock_provider "aws" {
  override_during = plan
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:chronote-prod/openai-api-key-abcdef" } }
  mock_resource "aws_s3_bucket" { defaults = { arn = "arn:aws:s3:::test-artifacts", bucket = "test-artifacts" } }
  mock_resource "aws_dynamodb_table" { defaults = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/test" } }
  mock_resource "aws_ecs_service" { defaults = { id = "arn:aws:ecs:us-east-1:123456789012:service/chronote-prod-bot-cluster/chronote-prod-bot-service" } }
  mock_resource "aws_ecs_cluster" { defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/chronote-prod-bot-cluster" } }
  mock_resource "aws_ecr_repository" { defaults = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/chronote-prod-bot-repo" } }
  mock_resource "aws_lb_listener" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/test/1234567890123456/1234567890123456" } }
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
  project_name       = "chronote"
  GITHUB_TOKEN       = "mock"
  AWS_TOKEN_KEY      = "mock"
  DISCORD_CLIENT_ID  = "mock"
  ENABLE_ELASTICACHE = false
  ENABLE_API_ALB     = true
  API_DOMAIN         = "sandbox.example.test"
  API_CERT_ARN       = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
}


run "disabled_by_default" {
  command = plan
  plan_options { target = [aws_iam_role.production_introduction] }
  variables { environment = "prod" }
  assert {
    condition     = length(aws_iam_role.production_introduction) == 0
    error_message = "Production introduction roles must be absent by default."
  }
}
run "sandbox_never_receives_production_roles" {
  command = plan
  plan_options { target = [aws_iam_role.production_introduction] }
  variables {
    environment                          = "sandbox"
    enable_production_introduction_roles = true
  }
  assert {
    condition     = length(aws_iam_role.production_introduction) == 0
    error_message = "Production authority must never be created for Sandbox."
  }
}
run "exact_production_authority" {
  command = plan
  plan_options { target = [aws_iam_role_policy.production_introduction, aws_iam_role_policy.production_prompt_guard] }
  variables {
    environment                              = "prod"
    github_environment                       = "production"
    enable_production_introduction_roles     = true
    production_introduction_task_definitions = ["arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:1", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:2", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:3", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:4"]
  }
  override_resource {
    target          = aws_dynamodb_table.meeting_history_table
    values          = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/exact-history" }
    override_during = plan
  }
  assert {
    condition = try(one([for s in jsondecode(aws_iam_role_policy.production_introduction[0].policy).Statement : s if contains(s.Action, "dynamodb:DescribeTable")]) == {
      Sid = "MeetingUpdateIndexMetadata", Effect = "Allow", Action = ["dynamodb:DescribeTable"], Resource = "arn:aws:dynamodb:us-east-1:123456789012:table/exact-history"
    }, false)
    error_message = "Index preflight must have only DescribeTable on the exact history table, without item-key conditions or broader metadata access."
  }
  assert {
    condition = try(one([for s in jsondecode(aws_iam_role_policy.production_introduction[0].policy).Statement : s if contains(s.Action, "ecs:DescribeTaskDefinition")]) == {
      Sid = "RegionalDefinitionMetadata", Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
    }, false)
    error_message = "Introduction task-definition metadata must use its own region-only wildcard statement; exact reviewed ARNs remain a source validation boundary."
  }
  assert {
    condition     = jsondecode(aws_iam_role.production_introduction["introduction"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:environment"] == "production" && jsondecode(aws_iam_role.production_introduction["introduction"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/master" && jsondecode(aws_iam_role.production_introduction["introduction"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:repository_id"] == "12345"
    error_message = "Trust must pin production, master and immutable repository identity."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_introduction[0].policy).Statement : !contains(s.Action, "dynamodb:DeleteItem") && !contains(s.Action, "ecs:RunTask") && !contains(s.Action, "ecs:UpdateTaskProtection") && !contains(s.Action, "secretsmanager:GetSecretValue") && !contains(s.Action, "ecs:RegisterTaskDefinition")])
    error_message = "Introduction cannot gain deletion, forced unprotection, registration or secret-read authority."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_prompt_guard[0].policy).Statement : alltrue([for a in s.Action : contains(["dynamodb:GetItem", "kms:Decrypt", "ecs:DescribeServices", "ecs:DescribeTaskDefinition", "secretsmanager:GetSecretValue"], a)])])
    error_message = "The existing guard role may only read the hold, serving metadata and the existing OpenAI secret."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_prompt_guard[0].policy).Statement : !contains(s.Action, "ecs:DescribeTaskDefinition") || (s.Resource == "*" && s.Condition.StringEquals["aws:RequestedRegion"] == var.aws_region)])
    error_message = "DescribeTaskDefinition is region restricted metadata, not IAM family isolation."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_prompt_guard[0].policy).Statement : !contains(s.Action, "ecs:DescribeServices") || s.Resource == aws_ecs_service.app_service.id])
    error_message = "DescribeServices must select only the existing service."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_prompt_guard[0].policy).Statement : !contains(s.Action, "secretsmanager:GetSecretValue") || (s.Resource == aws_secretsmanager_secret.openai_api_key.arn && s.Condition.StringEquals["secretsmanager:VersionStage"] == "AWSCURRENT")])
    error_message = "Only the existing OpenAI current secret version may be read by all guard-role consumers."
  }
  assert {
    condition     = aws_secretsmanager_secret.openai_api_key.kms_key_id == aws_kms_key.app_general.arn && alltrue([for s in jsondecode(aws_iam_role_policy.production_prompt_guard[0].policy).Statement : try(s.Sid, "") != "ServingOpenAIKeyDecrypt" || (s.Resource == aws_kms_key.app_general.arn && s.Condition.StringEquals["kms:ViaService"] == "secretsmanager.${var.aws_region}.amazonaws.com" && s.Condition.StringEquals["kms:CallerAccount"] == "123456789012" && s.Condition.StringEquals["kms:EncryptionContext:SecretARN"] == aws_secretsmanager_secret.openai_api_key.arn)])
    error_message = "Decrypt must use the secret actual key through Secrets Manager and its exact context."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_introduction[0].policy).Statement : !contains(s.Action, "ecs:StopTask")])
    error_message = "Empty standalone approval grants no StopTask."
  }
}

run "acceptance_disabled_by_default" {
  command = plan
  plan_options { target = [aws_iam_role.production_acceptance_collector, aws_iam_role_policy.production_launcher_reads] }
  variables {
    environment                              = "prod"
    enable_production_introduction_roles     = true
    production_introduction_task_definitions = ["arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:1", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:2", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:3", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:4"]
  }
  assert {
    condition     = length(aws_iam_role.production_acceptance_collector) == 0 && length(aws_iam_role_policy.production_launcher_reads) == 0
    error_message = "The read collector must remain separately disabled by default."
  }
}
run "acceptance_effective_policy" {
  command = plan
  plan_options { target = [aws_iam_role_policy.production_acceptance_collector, aws_iam_role_policy.production_introduction_fixture_reads, aws_iam_role_policy.production_launcher_reads] }
  variables {
    TRANSCRIPTS_PREFIX                           = "recordings/"
    environment                                  = "prod"
    github_environment                           = "production"
    enable_production_introduction_roles         = true
    enable_production_acceptance_collector       = true
    production_introduction_route_role_arns      = ["arn:aws:iam::123456789012:role/deploy", "arn:aws:iam::123456789012:role/apply", "arn:aws:iam::123456789012:role/prompt-guard"]
    production_introduction_reviewed_policy_arns = ["arn:aws:iam::123456789012:policy/reviewed"]
    production_acceptance_fixtures = [
      { guild_id = "guild", voice_channel_id = "voice", meeting_id = "first" },
      { guild_id = "guild", voice_channel_id = "voice", meeting_id = "second" }
    ]
    production_introduction_task_definitions = ["arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:1", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:2", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:3", "arn:aws:ecs:us-east-1:123456789012:task-definition/chronote-prod-bot-task:4"]
  }
  assert {
    condition = try(one([for s in jsondecode(aws_iam_role_policy.production_acceptance_collector[0].policy).Statement : s if contains(s.Action, "ecs:DescribeTaskDefinition")]) == {
      Sid = "RegionalDefinitionMetadata", Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
    }, false)
    error_message = "The effective collector policy must inherit the separate regional definition metadata statement without list, mutation or secret permissions."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.production_acceptance_collector[0].policy).Statement :
      s.Effect != "Allow" || !contains(s.Action, "kms:Decrypt") || try(
        s.Condition.StringEquals["kms:CallerAccount"] == "123456789012" &&
    contains(["s3.us-east-1.amazonaws.com", "dynamodb.us-east-1.amazonaws.com"], s.Condition.StringEquals["kms:ViaService"]), false)])
    error_message = "Every base KMS allow must retain ViaService and CallerAccount."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.production_acceptance_collector[0].policy).Statement :
    alltrue([for a in s.Action : !contains(["s3:ListBucket", "s3:PutObject", "kms:GenerateDataKey", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:TransactWriteItems", "dynamodb:DescribeTable"], a)])])
    error_message = "The collector may not list or write content, scan history, or gain mutation authority."
  }
  assert {
    condition = length(local.production_acceptance_objects) == 6 && length(local.production_acceptance_excluded_objects) == 4 && alltrue([
      for s in jsondecode(aws_iam_role_policy.production_acceptance_collector[0].policy).Statement :
      s.Sid != "GeneratedFixtureObjects" || (toset(s.Action) == toset(["s3:GetObject", "s3:GetObjectVersion"]) && toset(s.Resource) == toset(local.production_acceptance_objects))
    ])
    error_message = "Only three required content classes under two fixed fixture roots may be allowed."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.production_acceptance_collector[0].policy).Statement :
      !contains(["NoCheckpointTextInputs", "NoCheckpointTextKey"], s.Sid) || (s.Effect == "Deny" &&
    (s.Sid == "NoCheckpointTextInputs" ? toset(s.Resource) == toset(local.production_acceptance_excluded_objects) : toset(s.Condition.StringLike["kms:EncryptionContext:aws:s3:arn"]) == toset(local.production_acceptance_excluded_objects)))])
    error_message = "Explicit context and transcription denials must override wildcard allows in both S3 and KMS."
  }
  assert {
    condition     = alltrue([for s in jsondecode(aws_iam_role_policy.production_introduction_fixture_reads[0].policy).Statement : contains(["ExactFixtureGuildHistory", "ReadControlHistoryKeys", "NarrowFixtureSessions"], s.Sid)])
    error_message = "The final mutation role must use a narrowed session for all S3 content."
  }
  assert {
    condition     = toset(jsondecode(aws_iam_role.production_acceptance_collector[0].assume_role_policy).Statement[1].Condition.StringLike["sts:RoleSessionName"]) == toset(["introduction-content-*-1-0", "introduction-content-*-1-1"])
    error_message = "Only original-attempt fixture session names may assume the collector."
  }
  assert {
    condition = alltrue([for s in jsondecode(aws_iam_role_policy.production_acceptance_collector[0].policy).Statement : s.Sid != "ExactFixtureGuildHistory" || (
      toset(s.Action) == toset(["dynamodb:GetItem"]) && s.Resource == aws_dynamodb_table.meeting_history_table.arn &&
      toset(s.Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"]) == toset(["guild"]) &&
      toset(s.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"]) == toset(local.production_acceptance_history_attributes) &&
    s.Condition.Null["dynamodb:Attributes"] == "false")])
    error_message = "History IAM must stay partition/attribute restricted and GetItem-only; exact sort keys are enforced by the authenticated reader."
  }
  assert {
    condition = length(aws_iam_role_policy.production_launcher_reads) == 2 && alltrue([
      for policy in aws_iam_role_policy.production_launcher_reads : toset(flatten([for s in jsondecode(policy.policy).Statement : s.Action])) == toset(["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:GetOpenIDConnectProvider"])
    ])
    error_message = "Only the seven consumed read operations belong on the original mutation and collector roles."
  }
  assert {
    condition = alltrue(flatten([for policy in aws_iam_role_policy.production_launcher_reads : [for s in jsondecode(policy.policy).Statement : (
      s.Effect == "Allow" && !can(s.Condition) && alltrue([for arn in tolist(try(tolist(s.Resource), [s.Resource])) : can(regex(s.Sid == "NamedRoleMetadata" ? "^arn:aws:iam::[0-9]{12}:role/[^*?]+$" : s.Sid == "DeclaredPolicyMetadata" ? "^arn:aws:iam::(aws|[0-9]{12}):policy/[^*?]+$" : "^arn:aws:iam::[0-9]{12}:oidc-provider/token.actions.githubusercontent.com$", arn))])
    )]]))
    error_message = "IAM metadata must use exact matching role, policy and provider resources without a regional condition."
  }

}
