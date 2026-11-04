# Source declarations only. Provision through separately reviewed existing authority.
variable "enable_production_introduction_roles" {
  type    = bool
  default = false
}
# Ordinary deploys need the prompt guard role without introduction authority.
variable "enable_production_prompt_guard_role" {
  type    = bool
  default = false
}
variable "production_introduction_task_definitions" {
  type    = set(string)
  default = []
  validation {
    condition     = alltrue([for arn in var.production_introduction_task_definitions : can(regex("^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[^:*]+:[0-9]+$", arn))])
    error_message = "Pin exact legacy, bootstrap, failed-unserved replacement and fixture task definition revisions."
  }
}
variable "production_introduction_standalone_tasks" {
  type    = set(string)
  default = []
  validation {
    condition     = alltrue([for arn in var.production_introduction_standalone_tasks : can(regex("^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task/[A-Za-z0-9_-]{1,255}/[0-9a-f]{32}$", arn))])
    error_message = "Only exact long task ARNs with a cluster name and 32-character lowercase hexadecimal task ID are permitted."
  }
}
locals {
  production_introduction_enabled = var.environment == "prod" && var.enable_production_introduction_roles
  production_prompt_guard_enabled = var.environment == "prod" && (var.enable_production_introduction_roles || var.enable_production_prompt_guard_role)
  production_oidc_roles           = toset(concat(local.production_introduction_enabled ? ["introduction"] : [], local.production_prompt_guard_enabled ? ["prompt-guard"] : []))
  production_introduction_tables = [
    aws_dynamodb_table.deployment_control_table,
    aws_dynamodb_table.active_meeting_table,
    aws_dynamodb_table.meeting_history_table,
    aws_dynamodb_table.meeting_control_command_table,
    aws_dynamodb_table.personal_media_upload_job_table,
    aws_dynamodb_table.personal_recording_segment_table,
    aws_dynamodb_table.notion_integration_table,
    aws_dynamodb_table.stripe_webhook_event_table,
    aws_dynamodb_table.guild_subscription_table
  ]
}
data "aws_iam_openid_connect_provider" "production_introduction" {
  count = local.production_prompt_guard_enabled ? 1 : 0
  arn   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}
data "github_organization" "production_introduction_owner" {
  count        = local.production_prompt_guard_enabled ? 1 : 0
  name         = var.github_owner
  summary_only = true
}
resource "aws_iam_role" "production_introduction" {
  for_each             = local.production_oidc_roles
  name                 = "${local.name_prefix}-${each.key}"
  max_session_duration = each.key == "introduction" ? 10800 : 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.production_introduction[0].arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub"                 = "repo:Chronote-gg/Chronote:environment:production"
        "token.actions.githubusercontent.com:environment"         = "production"
        "token.actions.githubusercontent.com:ref"                 = "refs/heads/master"
        "token.actions.githubusercontent.com:workflow"            = each.key == "introduction" ? "Production introduction" : "Meeting Notes Bot Deploy"
        "token.actions.githubusercontent.com:repository_id"       = tostring(data.github_repository.repo.repo_id)
        "token.actions.githubusercontent.com:repository_owner_id" = data.github_organization.production_introduction_owner[0].id
      } }
    }]
  })
  lifecycle {
    precondition {
      condition     = var.github_owner == "Chronote-gg" && var.github_repository == "Chronote" && var.github_environment == "production" && length(aws_lb_listener.api_https) == 1 && (each.key != "introduction" || length(var.production_introduction_task_definitions) == 4)
      error_message = "Production authority requires exact repository/environment, HTTPS routing, and four reviewed immutable definitions."
    }
    precondition {
      condition     = alltrue([for arn in var.production_introduction_task_definitions : startswith(arn, "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.production_task_family}:")]) && alltrue([for arn in var.production_introduction_standalone_tasks : startswith(arn, "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.main.name}/")])
      error_message = "Introduction authority cannot cross account, region, cluster, or task family."
    }
  }
}
resource "aws_iam_role_policy" "production_prompt_guard" {
  count = local.production_prompt_guard_enabled ? 1 : 0
  role  = aws_iam_role.production_introduction["prompt-guard"].id
  name  = "read-introduction-hold"
  # All trusted guard-role consumers can read this key and regional task-definition metadata.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = aws_dynamodb_table.deployment_control_table.arn, Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["ENV"] } } },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.app_general.arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.${var.aws_region}.amazonaws.com", "kms:CallerAccount" = data.aws_caller_identity.current.account_id, "kms:EncryptionContext:aws:dynamodb:tableName" = aws_dynamodb_table.deployment_control_table.name } } }
    , { Sid = "ServingServiceMetadata", Effect = "Allow", Action = ["ecs:DescribeServices"], Resource = local.production_service_arn },
    { Sid = "RegionalDefinitionMetadata", Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } } },
    { Sid = "ServingOpenAIKey", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.openai_api_key.arn, Condition = { StringEquals = { "secretsmanager:VersionStage" = "AWSCURRENT" } } },
    { Sid = "ServingOpenAIKeyDecrypt", Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.app_general.arn, Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com", "kms:CallerAccount" = data.aws_caller_identity.current.account_id, "kms:EncryptionContext:SecretARN" = aws_secretsmanager_secret.openai_api_key.arn } } }
  ] })
}
resource "aws_iam_role_policy" "production_introduction" {
  count = local.production_introduction_enabled ? 1 : 0
  role  = aws_iam_role.production_introduction["introduction"].id
  name  = "finite-production-introduction"
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Sid = "BoundService", Effect = "Allow", Action = ["ecs:DescribeServices", "ecs:ListServiceDeployments"], Resource = aws_ecs_service.app_service.id },
    { Sid = "PinnedServiceUpdate", Effect = "Allow", Action = ["ecs:UpdateService"], Resource = aws_ecs_service.app_service.id, Condition = { ArnEquals = { "ecs:task-definition" = sort(tolist(var.production_introduction_task_definitions)) } } },
    { Sid = "TaskMetadata", Effect = "Allow", Action = ["ecs:DescribeTasks", "ecs:GetTaskProtection"], Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.main.name}/*" },
    { Sid = "RegionalDefinitionMetadata", Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } } },
    { Sid = "ClusterInventory", Effect = "Allow", Action = ["ecs:ListTasks", "ecs:ListServices"], Resource = "*", Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn } } },
    { Sid = "ServiceRevisionMetadata", Effect = "Allow", Action = ["ecs:DescribeServiceDeployments", "ecs:DescribeServiceRevisions"], Resource = [aws_ecs_service.app_service.id, "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service-deployment/${aws_ecs_cluster.main.name}/${local.name_prefix}-bot-service/*", "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service-revision/${aws_ecs_cluster.main.name}/${local.name_prefix}-bot-service/*"] },
    { Sid = "ExactListener", Effect = "Allow", Action = ["elasticloadbalancing:ModifyListener"], Resource = aws_lb_listener.api_https[0].arn },
    { Sid = "TopologyMetadata", Effect = "Allow", Action = ["elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes", "elasticloadbalancing:DescribeTargetHealth"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } } },
    { Sid = "SourceImageMetadata", Effect = "Allow", Action = ["ecr:DescribeImages"], Resource = aws_ecr_repository.app_ecr_repo.arn },
    { Sid = "ExactTaskRoles", Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.ecs_task_app_role.arn, aws_iam_role.ecs_task_execution_role.arn], Condition = { StringEquals = { "iam:PassedToService" = ["ecs-tasks.amazonaws.com", "ecs.amazonaws.com"] } } },
    { Sid = "ControlAuthority", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.deployment_control_table.arn, Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["ENV", "INTRODUCTION#*", "FIXTURE#*"] } } },
    { Sid = "FixtureCommands", Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = aws_dynamodb_table.meeting_control_command_table.arn, Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["fixture:*"] } } },
    { Sid = "MeetingUpdateIndexMetadata", Effect = "Allow", Action = ["dynamodb:DescribeTable"], Resource = aws_dynamodb_table.meeting_history_table.arn },
    { Sid = "RetainedMetadata", Effect = "Allow", Action = ["dynamodb:Scan", "dynamodb:ConditionCheckItem"], Resource = [for table in local.production_introduction_tables : table.arn] },
    { Sid = "TableKeysViaDynamo", Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.app_general.arn, Condition = { StringEquals = { "kms:ViaService" = "dynamodb.${var.aws_region}.amazonaws.com", "kms:CallerAccount" = data.aws_caller_identity.current.account_id, "kms:EncryptionContext:aws:dynamodb:tableName" = [for table in local.production_introduction_tables : table.name] } } },
    { Sid = "LauncherMetadata", Effect = "Allow", Action = ["application-autoscaling:DescribeScalableTargets", "application-autoscaling:DescribeScalingPolicies", "application-autoscaling:DescribeScheduledActions", "events:ListEventBuses", "events:ListRules", "events:ListTargetsByRule", "scheduler:ListScheduleGroups", "scheduler:ListSchedules"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } } }
    ], length(var.production_introduction_standalone_tasks) == 0 ? [] : [
    { Sid = "ApprovedStandaloneStops", Effect = "Allow", Action = ["ecs:StopTask"], Resource = sort(tolist(var.production_introduction_standalone_tasks)) }
  ]) })
}
output "production_introduction_role_arn" {
  value = local.production_introduction_enabled ? aws_iam_role.production_introduction["introduction"].arn : ""
}
output "production_prompt_guard_role_arn" {
  value = local.production_prompt_guard_enabled ? aws_iam_role.production_introduction["prompt-guard"].arn : ""
}
