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
            "token.actions.githubusercontent.com:sub"                 = "repo:${var.github_owner}/${var.github_repository}:environment:production",
            "token.actions.githubusercontent.com:repository_id"       = tostring(data.github_repository.repo.repo_id),
            "token.actions.githubusercontent.com:repository_owner_id" = data.github_organization.production_deployment_owner[0].id,
            "token.actions.githubusercontent.com:ref"                 = "refs/heads/master"
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
    Statement = [
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
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:ConditionCheckItem"
        ],
        Resource = aws_dynamodb_table.deployment_control_table.arn
      },
      {
        Sid    = "ProductionObservationAndPreflight",
        Effect = "Allow",
        Action = [
          "dynamodb:Scan"
        ],
        Resource = [
          aws_dynamodb_table.active_meeting_table.arn,
          aws_dynamodb_table.meeting_history_table.arn,
          aws_dynamodb_table.meeting_control_command_table.arn,
          aws_dynamodb_table.personal_media_upload_job_table.arn,
          aws_dynamodb_table.personal_recording_segment_table.arn,
          aws_dynamodb_table.guild_subscription_table.arn,
          aws_dynamodb_table.stripe_webhook_event_table.arn,
          aws_dynamodb_table.payment_transaction_table.arn
        ]
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
            "kms:EncryptionContext:aws:dynamodb:tableName" = [
              aws_dynamodb_table.deployment_control_table.name,
              aws_dynamodb_table.active_meeting_table.name,
              aws_dynamodb_table.meeting_history_table.name,
              aws_dynamodb_table.meeting_control_command_table.name,
              aws_dynamodb_table.personal_media_upload_job_table.name,
              aws_dynamodb_table.personal_recording_segment_table.name,
              aws_dynamodb_table.guild_subscription_table.name,
              aws_dynamodb_table.stripe_webhook_event_table.name,
              aws_dynamodb_table.payment_transaction_table.name
            ]
          }
        }
      },
      {
        # IAM cannot constrain the inline policy name or document; the reviewed executor must.
        Sid      = "RuntimeAdmissionFence",
        Effect   = "Allow",
        Action   = ["iam:GetRole", "iam:ListRolePolicies", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:PutRolePolicy", "iam:DeleteRolePolicy"],
        Resource = aws_iam_role.ecs_task_app_role.arn
      },
      {
        Sid      = "RuntimeManagedPolicyReadback",
        Effect   = "Allow",
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion"],
        Resource = concat([aws_iam_policy.dynamodb_access_policy.arn], [for name in ["bot-kms-policy", "bot-transcripts-s3-policy", "bot-appconfig-policy", "bedrock-data-automation", "bedrock-eval-s3"] : "${local.production_account_arn}:policy/${local.name_prefix}-${name}"])
      },
      {
        # Session policy binds the exact task; executor binds the reviewed probe command.
        Sid      = "RuntimePrincipalProbe",
        Effect   = "Allow",
        Action   = ["ecs:ExecuteCommand"],
        Resource = [aws_ecs_cluster.main.arn, "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.main.name}/*"],
        Condition = {
          StringEquals = {
            "ecs:container-name" = "${local.name_prefix}-bot"
          }
        }
      },
      {
        # These discovery APIs do not support resource-level permissions.
        Sid       = "ProducerInventoryInRegion",
        Effect    = "Allow",
        Action    = ["application-autoscaling:DescribeScalableTargets", "application-autoscaling:DescribeScalingPolicies", "application-autoscaling:DescribeScheduledActions", "events:ListEventBuses", "events:ListRules", "scheduler:ListSchedules"],
        Resource  = "*",
        Condition = { StringEquals = { "aws:RequestedRegion" = var.aws_region } }
      },
      {
        Sid      = "ProducerTargetsInAccount",
        Effect   = "Allow",
        Action   = ["events:DescribeRule", "events:ListTargetsByRule"],
        Resource = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/*"
      },
      {
        Sid      = "ScheduledProducerTargetsInAccount",
        Effect   = "Allow",
        Action   = ["scheduler:GetSchedule"],
        Resource = "arn:aws:scheduler:${var.aws_region}:${data.aws_caller_identity.current.account_id}:schedule/*/*"
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
      }
    ]
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
