locals {
  secrets_prefix = local.name_prefix
  secrets_tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret" "discord_bot_token" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/discord-bot-token"
  description = "Discord bot token"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret" "discord_client_secret" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/discord-client-secret"
  description = "Discord OAuth client secret"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret" "oauth_secret" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/oauth-secret"
  description = "Session/OAuth secret"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret" "notion_client_secret" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/notion-client-secret"
  description = "Notion OAuth client secret"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret" "openai_api_key" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/openai-api-key"
  description = "OpenAI API key"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret" "langfuse_public_key" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/langfuse-public-key"
  description = "Langfuse public key"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret" "langfuse_secret_key" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/langfuse-secret-key"
  description = "Langfuse secret key"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret_version" "langfuse_public_key_value" {
  count         = var.LANGFUSE_PUBLIC_KEY != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.langfuse_public_key.id
  secret_string = var.LANGFUSE_PUBLIC_KEY
}

resource "aws_secretsmanager_secret_version" "langfuse_secret_key_value" {
  count         = var.LANGFUSE_SECRET_KEY != "" ? 1 : 0
  secret_id     = aws_secretsmanager_secret.langfuse_secret_key.id
  secret_string = var.LANGFUSE_SECRET_KEY
}

resource "aws_secretsmanager_secret" "stripe_secret_key" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/stripe-secret-key"
  description = "Stripe secret API key"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

resource "aws_secretsmanager_secret" "stripe_webhook_secret" {
  #checkov:skip=CKV2_AWS_57 reason: Rotation requires a Lambda; handled manually for now.
  name        = "${local.secrets_prefix}/stripe-webhook-secret"
  description = "Stripe webhook signing secret"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags
}

data "aws_iam_policy_document" "ecs_secrets_policy" {
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = [
      aws_secretsmanager_secret.discord_bot_token.arn,
      aws_secretsmanager_secret.discord_client_secret.arn,
      aws_secretsmanager_secret.oauth_secret.arn,
      aws_secretsmanager_secret.notion_client_secret.arn,
      aws_secretsmanager_secret.openai_api_key.arn,
      aws_secretsmanager_secret.langfuse_public_key.arn,
      aws_secretsmanager_secret.langfuse_secret_key.arn,
      aws_secretsmanager_secret.stripe_secret_key.arn,
      aws_secretsmanager_secret.stripe_webhook_secret.arn,
    ]
  }
}

resource "aws_iam_policy" "ecs_task_secrets_policy" {
  name   = "${local.name_prefix}-ecs-task-secrets"
  policy = data.aws_iam_policy_document.ecs_secrets_policy.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_exec_secrets_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.ecs_task_secrets_policy.arn
}

output "secrets_manager_arns" {
  description = "Secrets Manager ARNs for application secrets"
  value = {
    discord_bot_token      = aws_secretsmanager_secret.discord_bot_token.arn
    discord_client_secret  = aws_secretsmanager_secret.discord_client_secret.arn
    oauth_secret           = aws_secretsmanager_secret.oauth_secret.arn
    notion_client_secret   = aws_secretsmanager_secret.notion_client_secret.arn
    openai_api_key         = aws_secretsmanager_secret.openai_api_key.arn
    langfuse_public_key    = aws_secretsmanager_secret.langfuse_public_key.arn
    langfuse_secret_key    = aws_secretsmanager_secret.langfuse_secret_key.arn
    stripe_secret_key      = aws_secretsmanager_secret.stripe_secret_key.arn
    stripe_webhook_secret  = aws_secretsmanager_secret.stripe_webhook_secret.arn
  }
}
