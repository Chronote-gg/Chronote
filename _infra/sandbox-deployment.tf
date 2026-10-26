data "aws_iam_openid_connect_provider" "github_deploy" {
  count = var.environment == "sandbox" ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

data "github_organization" "deployment_owner" {
  count        = var.environment == "sandbox" ? 1 : 0
  name         = var.github_owner
  summary_only = true
}

resource "aws_iam_role" "sandbox_deploy" {
  count                = var.environment == "sandbox" ? 1 : 0
  name                 = "${local.name_prefix}-github-deploy"
  max_session_duration = 10800
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid    = "ChronoteSandboxGitHubOIDC",
        Effect = "Allow",
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github_deploy[0].arn
        },
        Action = "sts:AssumeRoleWithWebIdentity",
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub"                 = "repo:${var.github_owner}/${var.github_repository}:environment:sandbox",
            "token.actions.githubusercontent.com:repository_id"       = tostring(data.github_repository.repo.repo_id),
            "token.actions.githubusercontent.com:repository_owner_id" = data.github_organization.deployment_owner[0].id
          },
          StringLike = {
            "token.actions.githubusercontent.com:ref" = [
              "refs/heads/master",
              "refs/heads/codex/*"
            ]
          }
        }
      }
    ]
  })
  lifecycle {
    precondition {
      condition     = var.github_environment == "sandbox" && length(aws_lb_listener.api_https) == 1
      error_message = "Sandbox deployment requires the sandbox GitHub environment and HTTPS deployment routing."
    }
  }
}

resource "aws_iam_role_policy" "sandbox_deploy" {
  count = var.environment == "sandbox" ? 1 : 0
  name  = "${local.name_prefix}-backend-deploy"
  role  = aws_iam_role.sandbox_deploy[0].id
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid    = "SandboxService",
        Effect = "Allow",
        Action = [
          "ecs:DescribeServices",
          "ecs:UpdateService"
        ],
        Resource = aws_ecs_service.app_service.id,
        Condition = {
          ArnLikeIfExists = {
            "ecs:task-definition" = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${aws_ecs_task_definition.app_task.family}:*"
          }
        }
      },
      {
        Sid    = "SandboxTaskMetadata",
        Effect = "Allow",
        Action = [
          "ecs:DescribeTasks",
          "ecs:GetTaskProtection"
        ],
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.main.name}/*"
      },
      {
        Sid    = "SandboxTaskInventory",
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
        Sid    = "SandboxTaskDefinitionRegistration",
        Effect = "Allow",
        Action = [
          "ecs:RegisterTaskDefinition",
          "ecs:TagResource"
        ],
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${aws_ecs_task_definition.app_task.family}:*"
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
        Sid    = "SandboxImagePublish",
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
        Resource = aws_ecr_repository.app_ecr_repo.arn
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
        Sid    = "PassOnlySandboxRuntimeRoles",
        Effect = "Allow",
        Action = [
          "iam:PassRole"
        ],
        Resource = [
          aws_iam_role.ecs_task_app_role.arn,
          aws_iam_role.ecs_task_execution_role.arn
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
        Sid    = "SandboxObservationAndPreflight",
        Effect = "Allow",
        Action = [
          "dynamodb:Scan"
        ],
        Resource = [
          aws_dynamodb_table.active_meeting_table.arn,
          aws_dynamodb_table.meeting_history_table.arn,
          aws_dynamodb_table.meeting_control_command_table.arn,
          aws_dynamodb_table.personal_media_upload_job_table.arn
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
              aws_dynamodb_table.personal_media_upload_job_table.name
            ]
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
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "sandbox_deploy_routing" {
  count      = var.environment == "sandbox" ? 1 : 0
  role       = aws_iam_role.sandbox_deploy[0].name
  policy_arn = aws_iam_policy.deployment_routing[0].arn
}

resource "github_actions_environment_variable" "sandbox_deploy_role" {
  count         = var.environment == "sandbox" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "SANDBOX_BACKEND_DEPLOY_ROLE_ARN"
  value         = aws_iam_role.sandbox_deploy[0].arn
}

resource "github_actions_environment_variable" "sandbox_deploy_account" {
  count         = var.environment == "sandbox" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "AWS_ACCOUNT_ID"
  value         = data.aws_caller_identity.current.account_id
}

output "sandbox_backend_deploy_role_arn" {
  value = var.environment == "sandbox" ? aws_iam_role.sandbox_deploy[0].arn : ""
}
