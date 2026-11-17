data "aws_iam_openid_connect_provider" "github_production_deploy" {
  count = var.environment == "prod" ? 1 : 0
  arn   = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

# Built from stable names so a targeted runtime plan never refreshes or changes
# the serving service, its task definition or their unrelated inputs.
locals {
  production_service_arn = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${aws_ecs_cluster.main.name}/${local.name_prefix}-bot-service"
  production_task_family = "${local.name_prefix}-bot-task"
  production_account_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}"
}

data "github_organization" "production_deployment_owner" {
  count        = var.environment == "prod" ? 1 : 0
  name         = var.github_owner
  summary_only = true
}

resource "aws_iam_role" "production_deploy" {
  count                = var.environment == "prod" ? 1 : 0
  name                 = "${local.name_prefix}-github-deploy"
  max_session_duration = 10800
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid    = "ChronoteProductionGitHubOIDC",
        Effect = "Allow",
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github_production_deploy[0].arn
        },
        Action = "sts:AssumeRoleWithWebIdentity",
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub"                 = [for name in local.production_deploy_environments : "repo:${var.github_owner}/${var.github_repository}:environment:${name}"],
            "token.actions.githubusercontent.com:repository_id"       = tostring(data.github_repository.repo.repo_id),
            "token.actions.githubusercontent.com:repository_owner_id" = data.github_organization.production_deployment_owner[0].id,
            "token.actions.githubusercontent.com:ref"                 = "refs/heads/master",
            "token.actions.githubusercontent.com:workflow"            = "Meeting Notes Bot Deploy"
          }
        }
      }
    ]
  })
  lifecycle {
    precondition {
      condition     = var.github_environment == "production" && (var.ENABLE_API_ALB && var.API_DOMAIN != "" && (var.API_CERT_ARN != "" || var.HOSTED_ZONE_NAME != ""))
      error_message = "Production deployment requires the production GitHub environment and HTTPS deployment routing."
    }
  }
}

resource "aws_iam_role_policy" "production_deploy" {
  count = var.environment == "prod" ? 1 : 0
  name  = "${local.name_prefix}-backend-deploy"
  role  = aws_iam_role.production_deploy[0].id
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = concat([
      {
        Sid    = "ProductionService",
        Effect = "Allow",
        Action = [
          "ecs:DescribeServices",
          "ecs:UpdateService"
        ],
        Resource = local.production_service_arn,
        Condition = {
          ArnLikeIfExists = {
            "ecs:task-definition" = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.production_task_family}:*"
          }
        }
      },
      {
        Sid    = "ProductionTaskMetadata",
        Effect = "Allow",
        Action = [
          "ecs:DescribeTasks",
          "ecs:GetTaskProtection"
        ],
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.main.name}/*"
      },
      {
        Sid    = "ProductionTaskInventory",
        Effect = "Allow",
        Action = [
          "ecs:ListTasks"
        ],
        Resource = "*",
        Condition = {
          ArnEquals = {
            "ecs:cluster" = aws_ecs_cluster.main.arn
          }
        }
      },
      {
        Sid    = "ProductionTaskDefinitionRegistration",
        Effect = "Allow",
        Action = [
          "ecs:RegisterTaskDefinition",
          "ecs:TagResource"
        ],
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.production_task_family}:*"
      },
      {
        Sid    = "DefinitionDiscoveryInRegion",
        Effect = "Allow",
        Action = [
          "ecs:ListTaskDefinitions",
          "ecs:DescribeTaskDefinition"
        ],
        Resource = "*",
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.aws_region
          }
        }
      },
      {
        Sid    = "ProductionImagePublish",
        Effect = "Allow",
        Action = [
          "ecr:DescribeImages",
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage"
        ],
        Resource = "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/${local.name_prefix}-bot-repo"
      },
      {
        Sid    = "RegistryAuthenticationInRegion",
        Effect = "Allow",
        Action = [
          "ecr:GetAuthorizationToken"
        ],
        Resource = "*",
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.aws_region
          }
        }
      },
      {
        Sid    = "PassOnlyProductionRuntimeRoles",
        Effect = "Allow",
        Action = [
          "iam:PassRole"
        ],
        Resource = [
          aws_iam_role.ecs_task_app_role.arn,
          "${local.production_account_arn}:role/${local.name_prefix}-ecs-task-exec-role"
        ],
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid    = "DeploymentControlProtocol",
        Effect = "Allow",
        # deploy.cjs reads the worker registry and nothing else.
        Action   = ["dynamodb:Query"],
        Resource = aws_dynamodb_table.deployment_control_table.arn
      },
      {
        Sid    = "ExistingTableKeysThroughDynamoDB",
        Effect = "Allow",
        Action = [
          "kms:Decrypt"
        ],
        Resource = aws_kms_key.app_general.arn,
        Condition = {
          StringEquals = {
            "kms:ViaService"                                  = "dynamodb.${var.aws_region}.amazonaws.com",
            "kms:CallerAccount"                               = data.aws_caller_identity.current.account_id,
            "kms:EncryptionContext:aws:dynamodb:subscriberId" = data.aws_caller_identity.current.account_id,
            "kms:EncryptionContext:aws:dynamodb:tableName"    = aws_dynamodb_table.deployment_control_table.name
          }
        }
      },
      {
        Sid    = "SecretVersionMetadataOnly",
        Effect = "Allow",
        Action = [
          "secretsmanager:ListSecretVersionIds"
        ],
        Resource = [
          aws_secretsmanager_secret.discord_bot_token.arn,
          aws_secretsmanager_secret.discord_client_secret.arn,
          aws_secretsmanager_secret.oauth_secret.arn,
          aws_secretsmanager_secret.openai_api_key.arn,
          aws_secretsmanager_secret.langfuse_public_key.arn,
          aws_secretsmanager_secret.langfuse_secret_key.arn,
          aws_secretsmanager_secret.stripe_secret_key.arn,
          aws_secretsmanager_secret.stripe_webhook_secret.arn
        ]
      },
      {
        # PutMetricData supports no resource ARNs; the namespace condition scopes it.
        Sid      = "DeployDrainTimeoutMetric",
        Effect   = "Allow",
        Action   = ["cloudwatch:PutMetricData"],
        Resource = "*",
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = "${local.name_prefix}/Deploy"
          }
        }
      }
      ], var.ENABLE_DEPLOY_RETIRE ? [
      {
        Sid      = "RetireOlderTasks",
        Effect   = "Allow",
        Action   = ["ecs:StopTask"],
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.main.name}/*"
      }
    ] : [])
  })
}

resource "aws_iam_role_policy_attachment" "production_deploy_routing" {
  count      = var.environment == "prod" ? 1 : 0
  role       = aws_iam_role.production_deploy[0].name
  policy_arn = aws_iam_policy.deployment_routing[0].arn
}

resource "github_actions_environment_variable" "production_deploy_role" {
  count         = var.environment == "prod" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "PRODUCTION_BACKEND_DEPLOY_ROLE_ARN"
  value         = aws_iam_role.production_deploy[0].arn
}

resource "github_actions_environment_variable" "production_deploy_account" {
  count         = var.environment == "prod" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "AWS_ACCOUNT_ID"
  value         = data.aws_caller_identity.current.account_id
}

# Deploy jobs may run under production-deploy, which has no required reviewer,
# so merges deploy unattended. Terraform Apply runs in the hand-made
# production-terraform environment. Both trust the deploy roles; see docs/deployment.md.
locals {
  production_deploy_environments = ["production", "production-deploy"]
  production_deploy_optional_variables = {
    DOCS_SITE_URL           = var.DOCS_SITE_URL
    DOCS_ALGOLIA_APP_ID     = var.DOCS_ALGOLIA_APP_ID
    DOCS_ALGOLIA_API_KEY    = var.DOCS_ALGOLIA_API_KEY
    DOCS_ALGOLIA_INDEX_NAME = var.DOCS_ALGOLIA_INDEX_NAME
  }
  # The variables Terraform writes to production, with the same values. A
  # tftest pins the match with the production resources.
  production_deploy_variables = var.environment == "prod" ? merge({
    AWS_REGION                         = "us-east-1"
    AWS_ACCOUNT_ID                     = data.aws_caller_identity.current.account_id
    ECR_REPOSITORY                     = "${local.name_prefix}-bot-repo"
    ECS_CLUSTER                        = aws_ecs_cluster.main.name
    ECS_SERVICE                        = "${local.name_prefix}-bot-service"
    ECS_TASK_FAMILY                    = local.production_task_family
    ECS_LOG_GROUP                      = local.app_log_group_name
    SECRETS_PREFIX                     = local.name_prefix
    FRONTEND_BUCKET                    = local.frontend_bucket_name
    FRONTEND_DISTRIBUTION_ID           = var.frontend_distribution_id
    DOCS_BUCKET                        = local.docs_bucket_name
    DOCS_DISTRIBUTION_ID               = var.docs_distribution_id
    VITE_API_BASE_URL                  = local.api_base_url
    PRODUCTION_BACKEND_DEPLOY_ROLE_ARN = aws_iam_role.production_deploy[0].arn
  }, { for name, value in local.production_deploy_optional_variables : name => value if value != "" }) : {}
}

resource "github_repository_environment" "production_deploy" {
  count             = var.environment == "prod" ? 1 : 0
  repository        = data.github_repository.repo.name
  environment       = "production-deploy"
  can_admins_bypass = false

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }
}

resource "github_repository_environment_deployment_policy" "production_deploy_master" {
  count          = var.environment == "prod" ? 1 : 0
  repository     = data.github_repository.repo.name
  environment    = github_repository_environment.production_deploy[0].environment
  branch_pattern = "master"
}

resource "github_actions_environment_variable" "production_deploy" {
  for_each      = local.production_deploy_variables
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.production_deploy[0].environment
  variable_name = each.key
  value         = each.value
}

output "production_backend_deploy_role_arn" {
  value = var.environment == "prod" ? aws_iam_role.production_deploy[0].arn : ""
}

# The channel service supports no resource ARNs. This does not grant StartSession.
resource "aws_iam_role_policy" "production_exec_channels" {
  count = var.environment == "prod" ? 1 : 0
  name  = "${local.name_prefix}-ecs-exec-channels"
  role  = aws_iam_role.ecs_task_app_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
      Resource = "*"
    }]
  })
}
