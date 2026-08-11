variable "APP_CONFIG_ENABLED" {
  description = "Enable AWS AppConfig for unified configuration"
  type        = string
  default     = "true"
}

variable "SUPER_ADMIN_USER_IDS" {
  description = "Comma-separated Discord user IDs for super admin access"
  type        = string
  default     = ""
}

resource "aws_appconfig_application" "chronote_config" {
  name        = "${local.name_prefix}-config"
  description = "Chronote unified configuration"
}

resource "aws_appconfig_environment" "chronote_config_env" {
  application_id = aws_appconfig_application.chronote_config.id
  name           = var.environment
  description    = "Chronote ${var.environment} environment"
}

resource "aws_appconfig_configuration_profile" "chronote_config_profile" {
  application_id = aws_appconfig_application.chronote_config.id
  name           = "chronote-config"
  location_uri   = "hosted"
  type           = "AWS.Freeform"
  description    = "Hosted configuration for unified settings"
}

resource "aws_appconfig_hosted_configuration_version" "chronote_config_version" {
  application_id           = aws_appconfig_application.chronote_config.id
  configuration_profile_id = aws_appconfig_configuration_profile.chronote_config_profile.configuration_profile_id
  content_type             = "application/json"
  content = jsonencode({
    values = {}
  })
}

resource "aws_appconfig_deployment_strategy" "chronote_config_strategy" {
  name                           = "${local.name_prefix}-config-all-at-once"
  description                    = "Immediate deployment for config changes"
  deployment_duration_in_minutes = 1
  growth_factor                  = 100
  final_bake_time_in_minutes     = 0
  growth_type                    = "LINEAR"
  replicate_to                   = "NONE"
}

resource "aws_appconfig_deployment" "chronote_config_deployment" {
  application_id           = aws_appconfig_application.chronote_config.id
  environment_id           = aws_appconfig_environment.chronote_config_env.environment_id
  configuration_profile_id = aws_appconfig_configuration_profile.chronote_config_profile.configuration_profile_id
  configuration_version    = aws_appconfig_hosted_configuration_version.chronote_config_version.version_number
  deployment_strategy_id   = aws_appconfig_deployment_strategy.chronote_config_strategy.id
  description              = "Initial configuration deployment"
}

resource "aws_iam_policy" "appconfig_access_policy" {
  #checkov:skip=CKV_AWS_355 reason: AppConfigData session actions require resource "*" and are scoped by app/env/profile IDs.
  #checkov:skip=CKV_AWS_290 reason: AppConfigData session actions require "*" and publish actions are limited to the app config workflow.
  name        = "${local.name_prefix}-bot-appconfig-policy"
  description = "Policy for Meeting Notes Bot to access AppConfig data"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "appconfig:CreateHostedConfigurationVersion",
          "appconfig:GetLatestConfiguration",
          "appconfig:StartConfigurationSession",
          "appconfig:StartDeployment"
        ],
        Resource = "*"
      }
    ]
  })
}

# Attach AppConfig policy to the task role
resource "aws_iam_role_policy_attachment" "ecs_task_appconfig_policy" {
  role       = aws_iam_role.ecs_task_app_role.name
  policy_arn = aws_iam_policy.appconfig_access_policy.arn
}

# Attach AppConfig policy to the execution role
resource "aws_iam_role_policy_attachment" "ecs_task_appconfig_policy_execution" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.appconfig_access_policy.arn
}

# Config Overrides Table
resource "aws_dynamodb_table" "config_overrides_table" {
  name         = "${local.name_prefix}-ConfigOverridesTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "scopeId"
  range_key    = "configKey"

  attribute {
    name = "scopeId"
    type = "S"
  }

  attribute {
    name = "configKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "ConfigOverridesTable"
  }
}

output "appconfig_application_id" {
  value = aws_appconfig_application.chronote_config.id
}

output "appconfig_environment_id" {
  value = aws_appconfig_environment.chronote_config_env.environment_id
}

output "appconfig_profile_id" {
  value = aws_appconfig_configuration_profile.chronote_config_profile.configuration_profile_id
}

output "appconfig_deployment_strategy_id" {
  value = aws_appconfig_deployment_strategy.chronote_config_strategy.id
}
