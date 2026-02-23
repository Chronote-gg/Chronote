terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.27"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.21"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
  backend "s3" {
    region               = "us-east-1"
    bucket               = "meeting-notes-terraform-state-bucket"
    key                  = "meeting-notes-terraform/state"
    dynamodb_table       = "meeting-notes-terraform-state-locks"
    workspace_key_prefix = "meeting-notes-terraform"
    encrypt              = true
  }
}

variable "project_name" {
  description = "Project name prefix for resource naming"
  type        = string
  default     = "meeting-notes"
}

variable "environment" {
  description = "Deployment environment (e.g., prod, staging)"
  type        = string
  default     = "prod"
}

variable "github_environment" {
  description = "GitHub Actions environment name to populate with deploy variables"
  type        = string
  default     = "sandbox"
}


variable "GITHUB_TOKEN" {
  sensitive = true
}
variable "AWS_TOKEN_KEY" {
  sensitive = true
}
variable "DISCORD_CLIENT_ID" {
  sensitive = true
}
variable "OPENAI_ORGANIZATION_ID" {
  sensitive = true
  default   = ""
}
variable "OPENAI_PROJECT_ID" {
  sensitive = true
  default   = ""
}

variable "LANGFUSE_PUBLIC_KEY" {
  description = "Langfuse public key (for prompt sync and tracing)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "LANGFUSE_SECRET_KEY" {
  description = "Langfuse secret key (for prompt sync and tracing)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "LANGFUSE_BASE_URL" {
  description = "Optional Langfuse base URL for self-hosted"
  type        = string
  default     = ""
}

variable "LANGFUSE_TRACING_ENABLED" {
  description = "Enable Langfuse tracing"
  type        = string
  default     = "true"
}

variable "LANGFUSE_TRACING_ENVIRONMENT" {
  description = "Langfuse tracing environment label"
  type        = string
  default     = ""
}

variable "LANGFUSE_RELEASE" {
  description = "Langfuse release label"
  type        = string
  default     = ""
}

variable "LANGFUSE_PROMPT_LABEL" {
  description = "Langfuse prompt label to use"
  type        = string
  default     = "production"
}

variable "LANGFUSE_PROMPT_MEETING_SUMMARY" {
  description = "Langfuse prompt name for meeting summaries"
  type        = string
  default     = "chronote-meeting-summary-chat"
}

variable "LANGFUSE_PROMPT_CACHE_TTL_MS" {
  description = "Langfuse prompt cache TTL in milliseconds"
  type        = string
  default     = "60000"
}

variable "NOTES_MODEL" {
  description = "OpenAI model for notes and summaries"
  type        = string
  default     = "gpt-5.2"
}

variable "TRANSCRIPTS_BUCKET" {
  description = "S3 bucket name for storing full meeting transcripts (leave blank to auto-generate)"
  type        = string
  default     = ""
}

variable "TRANSCRIPTS_PREFIX" {
  description = "Optional prefix inside the transcripts bucket"
  type        = string
  default     = ""
}

variable "FRONTEND_BUCKET" {
  description = "Optional bucket name for static frontend (leave blank to auto-generate)"
  type        = string
  default     = ""
}

variable "FRONTEND_DOMAIN" {
  description = "Optional custom domain for CloudFront; leave blank to use default distribution domain"
  type        = string
  default     = ""
}

variable "FRONTEND_CERT_ARN" {
  description = "ACM cert ARN in us-east-1 for the frontend CloudFront (required if FRONTEND_DOMAIN set)"
  type        = string
  default     = ""
}

variable "DOCS_BUCKET" {
  description = "Optional bucket name for static docs site (leave blank to auto-generate)"
  type        = string
  default     = ""
}

variable "DOCS_DOMAIN" {
  description = "Optional custom domain for docs CloudFront; leave blank to use default distribution domain"
  type        = string
  default     = ""
}

variable "DOCS_CERT_ARN" {
  description = "ACM cert ARN in us-east-1 for docs CloudFront (required if DOCS_DOMAIN set)"
  type        = string
  default     = ""
}

variable "DOCS_SITE_URL" {
  description = "Canonical docs site URL for Docusaurus builds (optional)"
  type        = string
  default     = ""
}

variable "DOCS_ALGOLIA_APP_ID" {
  description = "Algolia application ID for docs search (optional)"
  type        = string
  default     = ""
}

variable "DOCS_ALGOLIA_API_KEY" {
  description = "Algolia public search API key for docs search (optional)"
  type        = string
  default     = ""
}

variable "DOCS_ALGOLIA_INDEX_NAME" {
  description = "Algolia index name for docs search (optional)"
  type        = string
  default     = ""
}

variable "API_DOMAIN" {
  description = "Optional custom domain for the API (ALB); leave blank to use ALB DNS directly"
  type        = string
  default     = ""
}

variable "API_CERT_ARN" {
  description = "ACM cert ARN for the API domain (required if API_DOMAIN set and no ACM created)"
  type        = string
  default     = ""
}

variable "HOSTED_ZONE_NAME" {
  description = "Route53 hosted zone name (e.g., chronote.gg.) required if you want Terraform to create cert + DNS for FRONTEND_DOMAIN"
  type        = string
  default     = ""
}

variable "ENABLE_OAUTH" {
  sensitive = false
  default   = "false"
}

variable "DISCORD_CALLBACK_URL" {
  sensitive = true
  default   = ""
}

variable "NODE_ENV" {
  description = "Node environment for the container"
  type        = string
  default     = "production"
}

variable "ENABLE_ONBOARDING" {
  description = "Enable onboarding flow in the web app"
  type        = string
  default     = "false"
}

variable "FRONTEND_ALLOWED_ORIGINS" {
  description = "Comma-separated list of allowed origins for API CORS"
  type        = string
  default     = ""
}

variable "FRONTEND_SITE_URL" {
  description = "Primary frontend site URL"
  type        = string
  default     = ""
}

variable "LIVE_VOICE_MODE" {
  description = "Live voice mode (off or tts_gate)"
  type        = string
  default     = "off"
}

variable "LIVE_VOICE_GATE_MODEL" {
  description = "Live voice gate model"
  type        = string
  default     = "gpt-5-mini"
}

variable "LIVE_VOICE_RESPONDER_MODEL" {
  description = "Live voice responder model"
  type        = string
  default     = "gpt-4o-mini"
}

variable "LIVE_VOICE_TTS_MODEL" {
  description = "Live voice TTS model"
  type        = string
  default     = "gpt-4o-mini-tts"
}

variable "LIVE_VOICE_TTS_VOICE" {
  description = "Live voice TTS voice"
  type        = string
  default     = "alloy"
}

variable "LIVE_VOICE_WINDOW_SECONDS" {
  description = "Live voice context window seconds"
  type        = string
  default     = "90"
}

variable "LIVE_VOICE_WINDOW_LINES" {
  description = "Live voice context window lines"
  type        = string
  default     = "40"
}

variable "LIVE_VOICE_PAST_MEETINGS_MAX" {
  description = "Live voice past meetings max count"
  type        = string
  default     = "3"
}

variable "LIVE_VOICE_PAST_MEETINGS_MAX_CHARS" {
  description = "Live voice past meetings max chars"
  type        = string
  default     = "400"
}

variable "LIVE_VOICE_GATE_MAX_OUTPUT_TOKENS" {
  description = "Live voice gate max output tokens"
  type        = string
  default     = "256"
}

variable "LIVE_VOICE_THINKING_CUE" {
  description = "Live voice thinking cue enabled"
  type        = string
  default     = "true"
}

variable "LIVE_VOICE_THINKING_CUE_INTERVAL_MS" {
  description = "Live voice thinking cue interval ms"
  type        = string
  default     = "500"
}

variable "STRIPE_MODE" {
  description = "Stripe mode (test or live)"
  type        = string
  default     = "test"
}

variable "STRIPE_PRICE_BASIC" {
  description = "Optional fallback Stripe price ID for basic plan"
  type        = string
  default     = ""
}

variable "STRIPE_PRICE_LOOKUP_BASIC_MONTHLY" {
  description = "Stripe lookup key for basic monthly"
  type        = string
  default     = "chronote_basic_monthly"
}

variable "STRIPE_PRICE_LOOKUP_BASIC_ANNUAL" {
  description = "Stripe lookup key for basic annual"
  type        = string
  default     = "chronote_basic_annual"
}

variable "STRIPE_PRICE_LOOKUP_PRO_MONTHLY" {
  description = "Stripe lookup key for pro monthly"
  type        = string
  default     = "chronote_pro_monthly"
}

variable "STRIPE_PRICE_LOOKUP_PRO_ANNUAL" {
  description = "Stripe lookup key for pro annual"
  type        = string
  default     = "chronote_pro_annual"
}

variable "STRIPE_SUCCESS_URL" {
  description = "Stripe success redirect URL"
  type        = string
  default     = ""
}

variable "STRIPE_CANCEL_URL" {
  description = "Stripe cancel redirect URL"
  type        = string
  default     = ""
}

variable "STRIPE_PORTAL_RETURN_URL" {
  description = "Stripe portal return URL"
  type        = string
  default     = ""
}

variable "BILLING_LANDING_URL" {
  description = "Billing landing URL fallback"
  type        = string
  default     = ""
}


provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Service     = "chronote"
    }
  }
}

data "aws_caller_identity" "current" {}

provider "github" {
  owner = "BASIC-BIT"
  token = var.GITHUB_TOKEN
}

locals {
  name_prefix             = "${var.project_name}-${var.environment}"
  transcripts_bucket_name = var.TRANSCRIPTS_BUCKET != "" ? var.TRANSCRIPTS_BUCKET : "${local.name_prefix}-transcripts-${data.aws_caller_identity.current.account_id}"
  frontend_bucket_name    = var.FRONTEND_BUCKET != "" ? var.FRONTEND_BUCKET : "${local.name_prefix}-frontend-${data.aws_caller_identity.current.account_id}"
  docs_bucket_name        = var.DOCS_BUCKET != "" ? var.DOCS_BUCKET : "${local.name_prefix}-docs-${data.aws_caller_identity.current.account_id}"
  frontend_cert_arn = var.FRONTEND_CERT_ARN != "" ? var.FRONTEND_CERT_ARN : (
    length(aws_acm_certificate_validation.frontend_cert) > 0 ? aws_acm_certificate_validation.frontend_cert[0].certificate_arn : ""
  )
  docs_cert_arn = var.DOCS_CERT_ARN != "" ? var.DOCS_CERT_ARN : (
    length(aws_acm_certificate_validation.docs_cert) > 0 ? aws_acm_certificate_validation.docs_cert[0].certificate_arn : ""
  )
  api_cert_arn = var.API_CERT_ARN != "" ? var.API_CERT_ARN : (
    length(aws_acm_certificate_validation.api_cert) > 0 ? aws_acm_certificate_validation.api_cert[0].certificate_arn : ""
  )
  api_base_url = var.API_DOMAIN != "" ? "https://${var.API_DOMAIN}" : "http://${aws_lb.api_alb.dns_name}"
  discord_callback_url = var.DISCORD_CALLBACK_URL != "" ? var.DISCORD_CALLBACK_URL : (
    var.API_DOMAIN != "" ? "https://${var.API_DOMAIN}/auth/discord/callback" : ""
  )
}

resource "aws_ecr_repository" "app_ecr_repo" {
  name                 = "${local.name_prefix}-bot-repo"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.app_general.arn
  }
}

resource "aws_ecr_lifecycle_policy" "app_ecr_repo_lifecycle_policy" {
  repository = aws_ecr_repository.app_ecr_repo.name

  policy = <<EOF
{
    "rules": [
        {
            "rulePriority": 1,
            "description": "Keep last two images",
            "selection": {
                "tagStatus": "any",
                "countType": "imageCountMoreThan",
                "countNumber": 2
            },
            "action": {
                "type": "expire"
            }
        }
    ]
}
EOF
}

data "github_repository" "repo" {
  full_name = "BASIC-BIT/meeting-notes-discord-bot"
}

resource "github_repository_environment" "repo_env" {
  repository  = data.github_repository.repo.name
  environment = var.github_environment
}

resource "github_actions_environment_variable" "envvar_aws_region" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "AWS_REGION"
  value         = "us-east-1"
}

resource "github_actions_environment_variable" "envvar_ecr_repository" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "ECR_REPOSITORY"
  value         = aws_ecr_repository.app_ecr_repo.name
}

resource "github_actions_environment_variable" "envvar_aws_access_key_id" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "AWS_ACCESS_KEY_ID"
  value         = var.AWS_TOKEN_KEY
}

resource "github_actions_environment_variable" "envvar_frontend_bucket" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "FRONTEND_BUCKET"
  value         = aws_s3_bucket.frontend.bucket
}

resource "github_actions_environment_variable" "envvar_frontend_distribution_id" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "FRONTEND_DISTRIBUTION_ID"
  value         = aws_cloudfront_distribution.frontend.id
}

resource "github_actions_environment_variable" "envvar_docs_bucket" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "DOCS_BUCKET"
  value         = aws_s3_bucket.docs.bucket
}

resource "github_actions_environment_variable" "envvar_docs_distribution_id" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "DOCS_DISTRIBUTION_ID"
  value         = aws_cloudfront_distribution.docs.id
}

resource "github_actions_environment_variable" "envvar_docs_site_url" {
  count         = var.DOCS_SITE_URL != "" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "DOCS_SITE_URL"
  value         = var.DOCS_SITE_URL
}

resource "github_actions_environment_variable" "envvar_docs_algolia_app_id" {
  count         = var.DOCS_ALGOLIA_APP_ID != "" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "DOCS_ALGOLIA_APP_ID"
  value         = var.DOCS_ALGOLIA_APP_ID
}

resource "github_actions_environment_variable" "envvar_docs_algolia_api_key" {
  count         = var.DOCS_ALGOLIA_API_KEY != "" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "DOCS_ALGOLIA_API_KEY"
  value         = var.DOCS_ALGOLIA_API_KEY
}

resource "github_actions_environment_variable" "envvar_docs_algolia_index_name" {
  count         = var.DOCS_ALGOLIA_INDEX_NAME != "" ? 1 : 0
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "DOCS_ALGOLIA_INDEX_NAME"
  value         = var.DOCS_ALGOLIA_INDEX_NAME
}

resource "github_actions_environment_variable" "envvar_vite_api_base_url" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "VITE_API_BASE_URL"
  value         = local.api_base_url
}

resource "github_actions_environment_variable" "envvar_ecs_cluster" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "ECS_CLUSTER"
  value         = aws_ecs_cluster.main.name
}

resource "github_actions_environment_variable" "envvar_ecs_service" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "ECS_SERVICE"
  value         = aws_ecs_service.app_service.name
}

resource "github_actions_environment_variable" "envvar_ecs_task_family" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "ECS_TASK_FAMILY"
  value         = aws_ecs_task_definition.app_task.family
}

resource "github_actions_environment_variable" "envvar_ecs_log_group" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "ECS_LOG_GROUP"
  value         = aws_cloudwatch_log_group.app_log_group.name
}

resource "github_actions_environment_variable" "envvar_secrets_prefix" {
  repository    = data.github_repository.repo.name
  environment   = github_repository_environment.repo_env.environment
  variable_name = "SECRETS_PREFIX"
  value         = local.name_prefix
}

resource "aws_vpc" "app_vpc" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "app-vpc"
  }
}

#checkov:skip=CKV_AWS_130 reason: Public subnet kept (map_public_ip_on_launch=true) to avoid NAT cost; will move to private/NAT when budget allows.
resource "aws_subnet" "app_public_subnet_1" {
  #checkov:skip=CKV_AWS_130 reason: Public subnet kept (map_public_ip_on_launch=true) to avoid NAT cost; will move to private/NAT when budget allows.
  vpc_id                  = aws_vpc.app_vpc.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "us-east-1a"

  tags = {
    Name = "app-public-subnet-1"
  }
}

#checkov:skip=CKV_AWS_130 reason: Public subnet kept (map_public_ip_on_launch=true) to avoid NAT cost; will move to private/NAT when budget allows.
resource "aws_subnet" "app_public_subnet_2" {
  #checkov:skip=CKV_AWS_130 reason: Public subnet kept (map_public_ip_on_launch=true) to avoid NAT cost; will move to private/NAT when budget allows.
  vpc_id                  = aws_vpc.app_vpc.id
  cidr_block              = "10.0.2.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "us-east-1b"

  tags = {
    Name = "app-public-subnet-2"
  }
}

resource "aws_internet_gateway" "app_internet_gateway" {
  vpc_id = aws_vpc.app_vpc.id

  tags = {
    Name = "app-internet-gateway"
  }
}

resource "aws_route_table" "app_route_table" {
  vpc_id = aws_vpc.app_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.app_internet_gateway.id
  }

  tags = {
    Name = "app-route-table"
  }
}

resource "aws_route_table_association" "public_subnet_1_assoc" {
  subnet_id      = aws_subnet.app_public_subnet_1.id
  route_table_id = aws_route_table.app_route_table.id
}

resource "aws_route_table_association" "public_subnet_2_assoc" {
  subnet_id      = aws_subnet.app_public_subnet_2.id
  route_table_id = aws_route_table.app_route_table.id
}

resource "aws_security_group" "ecs_service_sg" {
  #checkov:skip=CKV_AWS_382 reason: Allow all egress temporarily while Discord voice debugging is in progress.
  revoke_rules_on_delete = true

  lifecycle {
    create_before_destroy = true
  }
  description = "ECS service SG for ${local.name_prefix}-bot"
  vpc_id      = aws_vpc.app_vpc.id

  ingress {
    description     = "Allow app traffic from the ALB to port 3001"
    from_port       = 3001
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [aws_security_group.api_alb_sg.id]
  }

  # Outbound HTTPS for Discord/OpenAI/AWS APIs
  egress {
    description = "Allow outbound HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # TEMP: allow all egress while voice debugging is in progress
  egress {
    description = "TEMP allow all egress (voice debugging) - tighten later"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # DNS to VPC resolver (10.0.0.2 for this VPC)
  egress {
    description = "Allow DNS (UDP) to VPC resolver"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["10.0.0.2/32"]
  }

  egress {
    description = "Allow DNS (TCP) to VPC resolver"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.2/32"]
  }

  tags = {
    Name = "ecs-service-sg"
  }
}

resource "aws_cloudwatch_log_group" "app_log_group" {
  name              = "/ecs/${local.name_prefix}-bot"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app_general.arn

  tags = {
    Name = "app-log-group"
  }
}

resource "aws_kms_key" "app_general" {
  description             = "KMS key for ECR, CloudWatch logs, and other app resources"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid       = "AllowRootAccount",
        Effect    = "Allow",
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" },
        Action    = "kms:*",
        Resource  = "*"
      },
      {
        Sid    = "AllowCloudWatchLogs",
        Effect = "Allow",
        Principal = {
          Service = "logs.us-east-1.amazonaws.com"
        },
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ],
        Resource = "*"
      },
      {
        Sid    = "AllowDynamoDB",
        Effect = "Allow",
        Principal = {
          Service = "dynamodb.amazonaws.com"
        },
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ],
        Resource = "*"
      },
      {
        Sid    = "AllowECR",
        Effect = "Allow",
        Principal = {
          Service = "ecr.amazonaws.com"
        },
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ],
        Resource = "*",
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = data.aws_caller_identity.current.account_id
            "kms:ViaService"    = "ecr.us-east-1.amazonaws.com"
          }
        }
      },
      {
        Sid    = "AllowCloudFrontOAC",
        Effect = "Allow",
        Principal = {
          Service = "cloudfront.amazonaws.com"
        },
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ],
        Resource = "*",
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${aws_cloudfront_distribution.frontend.id}"
          }
        }
      },
      {
        Sid    = "AllowCloudFrontDocsOAC",
        Effect = "Allow",
        Principal = {
          Service = "cloudfront.amazonaws.com"
        },
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ],
        Resource = "*",
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${aws_cloudfront_distribution.docs.id}"
          }
        }
      },
      {
        Sid    = "AllowSNSPublishers",
        Effect = "Allow",
        Principal = {
          Service = [
            "cloudwatch.amazonaws.com",
            "events.amazonaws.com",
            "sns.amazonaws.com"
          ]
        },
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ],
        Resource = "*",
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

resource "aws_s3_bucket" "transcripts" {
  #checkov:skip=CKV_AWS_18 reason: Access logging not enabled yet; will add if/when audit requirements demand it.
  #checkov:skip=CKV_AWS_144 reason: Cross-region replication not required for current stage.
  #checkov:skip=CKV2_AWS_62 reason: Event notifications not needed for transcripts storage.
  bucket = local.transcripts_bucket_name

  tags = {
    Name = "${local.name_prefix}-transcripts"
  }
}

resource "aws_s3_bucket" "frontend" {
  #checkov:skip=CKV_AWS_18 reason: Access logging not enabled yet; will add if/when audit requirements demand it.
  #checkov:skip=CKV_AWS_144 reason: Cross-region replication not required for current stage.
  #checkov:skip=CKV2_AWS_61 reason: Lifecycle configuration not required for static site bucket.
  #checkov:skip=CKV2_AWS_62 reason: Event notifications not needed for static site bucket.
  bucket        = local.frontend_bucket_name
  force_destroy = true

  tags = {
    Name = "${local.name_prefix}-frontend"
  }
}

resource "aws_s3_bucket" "docs" {
  #checkov:skip=CKV_AWS_18 reason: Access logging not enabled yet; will add if/when audit requirements demand it.
  #checkov:skip=CKV_AWS_144 reason: Cross-region replication not required for current stage.
  #checkov:skip=CKV2_AWS_61 reason: Lifecycle configuration not required for static docs bucket.
  #checkov:skip=CKV2_AWS_62 reason: Event notifications not needed for static docs bucket.
  bucket        = local.docs_bucket_name
  force_destroy = true

  tags = {
    Name = "${local.name_prefix}-docs"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.app_general.arn
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.app_general.arn
    }
  }
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "docs" {
  bucket = aws_s3_bucket.docs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "transcripts" {
  bucket                  = aws_s3_bucket.transcripts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.app_general.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_versioning" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_origin_access_control" "frontend_oac" {
  name                              = "${local.name_prefix}-frontend-oac"
  description                       = "OAC for frontend bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "docs_oac" {
  name                              = "${local.name_prefix}-docs-oac"
  description                       = "OAC for docs bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  #checkov:skip=CKV_AWS_86 reason: Access logging not enabled yet; will add if/when audit requirements demand it.
  #checkov:skip=CKV_AWS_310 reason: Origin failover not configured; single-origin setup is acceptable for now.
  #checkov:skip=CKV_AWS_374 reason: Geo restriction not required for current stage.
  #checkov:skip=CKV_AWS_68 reason: WAF not enabled yet; to be evaluated closer to launch.
  #checkov:skip=CKV2_AWS_42 reason: Custom SSL cert is conditional on FRONTEND_DOMAIN; default cert is acceptable if unset.
  #checkov:skip=CKV2_AWS_32 reason: Response headers policy not attached yet; will be added with security hardening pass.
  #checkov:skip=CKV2_AWS_47 reason: WAF AMR (Log4j) not configured without WAF.
  enabled             = true
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "frontend-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend_oac.id
  }

  default_cache_behavior {
    target_origin_id       = "frontend-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    compress    = true
    min_ttl     = 0
    default_ttl = 600
    max_ttl     = 3600
  }

  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "frontend-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    compress    = true
    min_ttl     = 3600
    default_ttl = 86400
    max_ttl     = 31536000
  }

  price_class = "PriceClass_100"

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  custom_error_response {
    error_caching_min_ttl = 0
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
  }

  custom_error_response {
    error_caching_min_ttl = 0
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
  }

  viewer_certificate {
    acm_certificate_arn            = var.FRONTEND_DOMAIN != "" ? local.frontend_cert_arn : null
    cloudfront_default_certificate = var.FRONTEND_DOMAIN == ""
    minimum_protocol_version       = "TLSv1.2_2021"
    ssl_support_method             = var.FRONTEND_DOMAIN != "" ? "sni-only" : null
  }

  aliases = var.FRONTEND_DOMAIN != "" ? [var.FRONTEND_DOMAIN] : []
}

resource "aws_cloudfront_distribution" "docs" {
  #checkov:skip=CKV_AWS_86 reason: Access logging not enabled yet; will add if/when audit requirements demand it.
  #checkov:skip=CKV_AWS_310 reason: Origin failover not configured; single-origin setup is acceptable for now.
  #checkov:skip=CKV_AWS_374 reason: Geo restriction not required for current stage.
  #checkov:skip=CKV_AWS_68 reason: WAF not enabled yet; to be evaluated closer to launch.
  #checkov:skip=CKV2_AWS_42 reason: Custom SSL cert is conditional on DOCS_DOMAIN; default cert is acceptable if unset.
  #checkov:skip=CKV2_AWS_32 reason: Response headers policy not attached yet; will be added with security hardening pass.
  #checkov:skip=CKV2_AWS_47 reason: WAF AMR (Log4j) not configured without WAF.
  enabled             = true
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.docs.bucket_regional_domain_name
    origin_id                = "docs-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.docs_oac.id
  }

  default_cache_behavior {
    target_origin_id       = "docs-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    compress    = true
    min_ttl     = 0
    default_ttl = 600
    max_ttl     = 3600
  }

  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "docs-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    compress    = true
    min_ttl     = 3600
    default_ttl = 86400
    max_ttl     = 31536000
  }

  price_class = "PriceClass_100"

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  custom_error_response {
    error_caching_min_ttl = 0
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
  }

  custom_error_response {
    error_caching_min_ttl = 0
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
  }

  viewer_certificate {
    acm_certificate_arn            = var.DOCS_DOMAIN != "" ? local.docs_cert_arn : null
    cloudfront_default_certificate = var.DOCS_DOMAIN == ""
    minimum_protocol_version       = "TLSv1.2_2021"
    ssl_support_method             = var.DOCS_DOMAIN != "" ? "sni-only" : null
  }

  aliases = var.DOCS_DOMAIN != "" ? [var.DOCS_DOMAIN] : []
}

resource "aws_s3_bucket_policy" "frontend_oac_policy" {
  bucket = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action = ["s3:GetObject"]
        Resource = [
          "${aws_s3_bucket.frontend.arn}/*"
        ]
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${aws_cloudfront_distribution.frontend.id}"
          }
        }
      }
    ]
  })

  depends_on = [aws_cloudfront_distribution.frontend]
}

resource "aws_s3_bucket_policy" "docs_oac_policy" {
  bucket = aws_s3_bucket.docs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action = ["s3:GetObject"]
        Resource = [
          "${aws_s3_bucket.docs.arn}/*"
        ]
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${aws_cloudfront_distribution.docs.id}"
          }
        }
      }
    ]
  })

  depends_on = [aws_cloudfront_distribution.docs]
}

resource "aws_s3_bucket_lifecycle_configuration" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

  rule {
    id     = "abort-mpu"
    status = "Enabled"
    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-bot-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# Define an IAM role for ECS task execution
resource "aws_iam_role" "ecs_task_execution_role" {
  name = "${local.name_prefix}-ecs-task-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action = "sts:AssumeRole",
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# Attach the required policy to the execution role
resource "aws_iam_role_policy_attachment" "ecs_task_execution_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Define IAM role for the task (application) permissions
resource "aws_iam_role" "ecs_task_app_role" {
  name = "${local.name_prefix}-ecs-task-app-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action = "sts:AssumeRole",
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# Create IAM policy for DynamoDB access
resource "aws_iam_policy" "dynamodb_access_policy" {
  name        = "${local.name_prefix}-bot-dynamodb-policy"
  description = "Policy for Meeting Notes Bot to access DynamoDB tables"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ],
        Resource = [
          aws_dynamodb_table.payment_transaction_table.arn,
          aws_dynamodb_table.stripe_webhook_event_table.arn,
          aws_dynamodb_table.interaction_receipt_table.arn,
          aws_dynamodb_table.active_meeting_table.arn,
          aws_dynamodb_table.access_logs_table.arn,
          aws_dynamodb_table.recording_transcript_table.arn,
          aws_dynamodb_table.auto_record_settings_table.arn,
          "${aws_dynamodb_table.auto_record_settings_table.arn}/index/*",
          aws_dynamodb_table.session_table.arn,
          aws_dynamodb_table.server_context_table.arn,
          aws_dynamodb_table.channel_context_table.arn,
          aws_dynamodb_table.dictionary_table.arn,
          aws_dynamodb_table.user_speech_settings_table.arn,
          aws_dynamodb_table.config_overrides_table.arn,
          aws_dynamodb_table.ask_conversation_table.arn,
          aws_dynamodb_table.feedback_table.arn,
          aws_dynamodb_table.meeting_history_table.arn,
          "${aws_dynamodb_table.meeting_history_table.arn}/index/*",
          aws_dynamodb_table.meeting_share_table.arn,
          aws_dynamodb_table.contact_feedback_table.arn,
          "${aws_dynamodb_table.contact_feedback_table.arn}/index/*",
          aws_dynamodb_table.installer_table.arn,
          aws_dynamodb_table.onboarding_state_table.arn,
          aws_dynamodb_table.guild_subscription_table.arn
        ]
      }
    ]
  })
}

# Attach DynamoDB policy to the task role
resource "aws_iam_role_policy_attachment" "ecs_task_dynamodb_policy" {
  role       = aws_iam_role.ecs_task_app_role.name
  policy_arn = aws_iam_policy.dynamodb_access_policy.arn
}

# Temporary belt-and-suspenders: also attach DynamoDB policy to the execution role to avoid AccessDenied
# if tasks start with the execution role due to misconfiguration. Remove once task_role is confirmed in use.
resource "aws_iam_role_policy_attachment" "ecs_task_dynamodb_policy_execution" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.dynamodb_access_policy.arn
}

# KMS permissions for app tasks (and execution role as backup)
resource "aws_iam_policy" "kms_app_policy" {
  name        = "${local.name_prefix}-bot-kms-policy"
  description = "Allow ECS tasks to use the app KMS key"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid    = "AllowKMSForApp"
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.app_general.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_kms_policy" {
  role       = aws_iam_role.ecs_task_app_role.name
  policy_arn = aws_iam_policy.kms_app_policy.arn
}

resource "aws_iam_role_policy_attachment" "ecs_task_exec_kms_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.kms_app_policy.arn
}

resource "aws_iam_policy" "transcripts_s3_policy" {
  name        = "${local.name_prefix}-bot-transcripts-s3-policy"
  description = "Allow ECS tasks to upload and read transcripts in the transcripts bucket"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:AbortMultipartUpload",
          "s3:ListBucket"
        ],
        Resource = [
          aws_s3_bucket.transcripts.arn,
          "${aws_s3_bucket.transcripts.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_transcripts_policy" {
  role       = aws_iam_role.ecs_task_app_role.name
  policy_arn = aws_iam_policy.transcripts_s3_policy.arn
}

resource "aws_iam_role_policy_attachment" "ecs_task_exec_transcripts_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.transcripts_s3_policy.arn
}

# Update the ECS task definition to include the execution role ARN
resource "aws_ecs_task_definition" "app_task" {
  family                   = "${local.name_prefix}-bot-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_task_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_app_role.arn

  container_definitions = jsonencode([
    {
      name      = "${local.name_prefix}-bot"
      image     = aws_ecr_repository.app_ecr_repo.repository_url
      cpu       = 512
      memory    = 1024
      essential = true
      portMappings = [
        {
          containerPort = 3001
          hostPort      = 3001
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app_log_group.name
          "awslogs-region"        = "us-east-1"
          "awslogs-stream-prefix" = "ecs"
        }
      }
      environment = [
        {
          name  = "DISCORD_CLIENT_ID"
          value = var.DISCORD_CLIENT_ID
        },
        {
          name  = "DISCORD_CALLBACK_URL"
          value = local.discord_callback_url
        },
        {
          name  = "ENABLE_OAUTH"
          value = var.ENABLE_OAUTH
        },
        {
          name  = "OPENAI_ORGANIZATION_ID"
          value = var.OPENAI_ORGANIZATION_ID
        },
        {
          name  = "OPENAI_PROJECT_ID"
          value = var.OPENAI_PROJECT_ID
        },
        {
          name  = "REDIS_URL"
          value = local.redis_url
        },
        {
          name  = "LANGFUSE_BASE_URL"
          value = var.LANGFUSE_BASE_URL
        },
        {
          name  = "LANGFUSE_TRACING_ENABLED"
          value = var.LANGFUSE_TRACING_ENABLED
        },
        {
          name  = "LANGFUSE_TRACING_ENVIRONMENT"
          value = var.LANGFUSE_TRACING_ENVIRONMENT
        },
        {
          name  = "LANGFUSE_RELEASE"
          value = var.LANGFUSE_RELEASE
        },
        {
          name  = "LANGFUSE_PROMPT_LABEL"
          value = var.LANGFUSE_PROMPT_LABEL
        },
        {
          name  = "LANGFUSE_PROMPT_MEETING_SUMMARY"
          value = var.LANGFUSE_PROMPT_MEETING_SUMMARY
        },
        {
          name  = "LANGFUSE_PROMPT_CACHE_TTL_MS"
          value = var.LANGFUSE_PROMPT_CACHE_TTL_MS
        },
        {
          name  = "NOTES_MODEL"
          value = var.NOTES_MODEL
        },
        {
          name  = "APP_CONFIG_ENABLED"
          value = var.APP_CONFIG_ENABLED
        },
        {
          name  = "APP_CONFIG_APPLICATION_ID"
          value = aws_appconfig_application.chronote_config.id
        },
        {
          name  = "APP_CONFIG_ENVIRONMENT_ID"
          value = aws_appconfig_environment.chronote_config_env.environment_id
        },
        {
          name  = "APP_CONFIG_PROFILE_ID"
          value = aws_appconfig_configuration_profile.chronote_config_profile.configuration_profile_id
        },
        {
          name  = "APP_CONFIG_DEPLOYMENT_STRATEGY_ID"
          value = aws_appconfig_deployment_strategy.chronote_config_strategy.id
        },
        {
          name  = "TRANSCRIPTS_BUCKET"
          value = local.transcripts_bucket_name
        },
        {
          name  = "TRANSCRIPTS_PREFIX"
          value = var.TRANSCRIPTS_PREFIX
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_PROFILE_ARN"
          value = var.BEDROCK_DATA_AUTOMATION_PROFILE_ARN
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_PROJECT_ARN"
          value = var.BEDROCK_DATA_AUTOMATION_PROJECT_ARN
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_INPUT_BUCKET"
          value = local.bedrock_input_bucket_name
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_OUTPUT_BUCKET"
          value = local.bedrock_output_bucket_name
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_INPUT_PREFIX"
          value = var.BEDROCK_DATA_AUTOMATION_INPUT_PREFIX
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_OUTPUT_PREFIX"
          value = var.BEDROCK_DATA_AUTOMATION_OUTPUT_PREFIX
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_POLL_INTERVAL_MS"
          value = var.BEDROCK_DATA_AUTOMATION_POLL_INTERVAL_MS
        },
        {
          name  = "BEDROCK_DATA_AUTOMATION_TIMEOUT_MS"
          value = var.BEDROCK_DATA_AUTOMATION_TIMEOUT_MS
        },
        {
          name  = "DDB_TABLE_PREFIX"
          value = "${local.name_prefix}-"
        },
        {
          name  = "NODE_ENV"
          value = var.NODE_ENV
        },
        {
          name  = "ENABLE_ONBOARDING"
          value = var.ENABLE_ONBOARDING
        },
        {
          name  = "FRONTEND_ALLOWED_ORIGINS"
          value = var.FRONTEND_ALLOWED_ORIGINS
        },
        {
          name  = "FRONTEND_SITE_URL"
          value = var.FRONTEND_SITE_URL
        },
        {
          name  = "LIVE_VOICE_MODE"
          value = var.LIVE_VOICE_MODE
        },
        {
          name  = "LIVE_VOICE_GATE_MODEL"
          value = var.LIVE_VOICE_GATE_MODEL
        },
        {
          name  = "LIVE_VOICE_RESPONDER_MODEL"
          value = var.LIVE_VOICE_RESPONDER_MODEL
        },
        {
          name  = "LIVE_VOICE_TTS_MODEL"
          value = var.LIVE_VOICE_TTS_MODEL
        },
        {
          name  = "LIVE_VOICE_TTS_VOICE"
          value = var.LIVE_VOICE_TTS_VOICE
        },
        {
          name  = "LIVE_VOICE_WINDOW_SECONDS"
          value = var.LIVE_VOICE_WINDOW_SECONDS
        },
        {
          name  = "LIVE_VOICE_WINDOW_LINES"
          value = var.LIVE_VOICE_WINDOW_LINES
        },
        {
          name  = "LIVE_VOICE_PAST_MEETINGS_MAX"
          value = var.LIVE_VOICE_PAST_MEETINGS_MAX
        },
        {
          name  = "LIVE_VOICE_PAST_MEETINGS_MAX_CHARS"
          value = var.LIVE_VOICE_PAST_MEETINGS_MAX_CHARS
        },
        {
          name  = "LIVE_VOICE_GATE_MAX_OUTPUT_TOKENS"
          value = var.LIVE_VOICE_GATE_MAX_OUTPUT_TOKENS
        },
        {
          name  = "LIVE_VOICE_THINKING_CUE"
          value = var.LIVE_VOICE_THINKING_CUE
        },
        {
          name  = "LIVE_VOICE_THINKING_CUE_INTERVAL_MS"
          value = var.LIVE_VOICE_THINKING_CUE_INTERVAL_MS
        },
        {
          name  = "STRIPE_MODE"
          value = var.STRIPE_MODE
        },
        {
          name  = "STRIPE_PRICE_BASIC"
          value = var.STRIPE_PRICE_BASIC
        },
        {
          name  = "STRIPE_PRICE_LOOKUP_BASIC_MONTHLY"
          value = var.STRIPE_PRICE_LOOKUP_BASIC_MONTHLY
        },
        {
          name  = "STRIPE_PRICE_LOOKUP_BASIC_ANNUAL"
          value = var.STRIPE_PRICE_LOOKUP_BASIC_ANNUAL
        },
        {
          name  = "STRIPE_PRICE_LOOKUP_PRO_MONTHLY"
          value = var.STRIPE_PRICE_LOOKUP_PRO_MONTHLY
        },
        {
          name  = "STRIPE_PRICE_LOOKUP_PRO_ANNUAL"
          value = var.STRIPE_PRICE_LOOKUP_PRO_ANNUAL
        },
        {
          name  = "STRIPE_SUCCESS_URL"
          value = var.STRIPE_SUCCESS_URL
        },
        {
          name  = "STRIPE_CANCEL_URL"
          value = var.STRIPE_CANCEL_URL
        },
        {
          name  = "STRIPE_PORTAL_RETURN_URL"
          value = var.STRIPE_PORTAL_RETURN_URL
        },
        {
          name  = "BILLING_LANDING_URL"
          value = var.BILLING_LANDING_URL
        },
        {
          name  = "SUPER_ADMIN_USER_IDS"
          value = var.SUPER_ADMIN_USER_IDS
        },
      ]
      secrets = [
        {
          name      = "DISCORD_BOT_TOKEN"
          valueFrom = aws_secretsmanager_secret.discord_bot_token.arn
        },
        {
          name      = "DISCORD_CLIENT_SECRET"
          valueFrom = aws_secretsmanager_secret.discord_client_secret.arn
        },
        {
          name      = "OAUTH_SECRET"
          valueFrom = aws_secretsmanager_secret.oauth_secret.arn
        },
        {
          name      = "OPENAI_API_KEY"
          valueFrom = aws_secretsmanager_secret.openai_api_key.arn
        },
        {
          name      = "LANGFUSE_PUBLIC_KEY"
          valueFrom = aws_secretsmanager_secret.langfuse_public_key.arn
        },
        {
          name      = "LANGFUSE_SECRET_KEY"
          valueFrom = aws_secretsmanager_secret.langfuse_secret_key.arn
        },
        {
          name      = "STRIPE_SECRET_KEY"
          valueFrom = aws_secretsmanager_secret.stripe_secret_key.arn
        },
        {
          name      = "STRIPE_WEBHOOK_SECRET"
          valueFrom = aws_secretsmanager_secret.stripe_webhook_secret.arn
        },
      ]
      #      healthCheck = {
      #        command     = ["CMD-SHELL", "curl -f http://127.0.0.1:3001/health || exit 1"]
      #        interval    = 30      # seconds
      #        timeout     = 5       # seconds
      #        retries     = 3
      #        startPeriod = 120      # seconds, grace period before health checks start
      #      }
    }
  ])
}

#checkov:skip=CKV_AWS_333 reason: Assigning public IP for now to avoid NAT Gateway cost; will migrate to private subnets with NAT when budget allows.
resource "aws_ecs_service" "app_service" {
  #checkov:skip=CKV_AWS_333 reason: Assigning public IP for now to avoid NAT Gateway cost; will migrate to private subnets with NAT when budget allows.
  name            = "${local.name_prefix}-bot-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app_task.arn

  # Deployments update the ECS service task definition outside Terraform.
  # Avoid Terraform reverting task definition revisions during infra applies.
  lifecycle {
    ignore_changes = [task_definition]
  }

  enable_execute_command = true

  desired_count = 1
  launch_type   = "FARGATE"

  deployment_controller {
    type = "ECS"
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = [aws_subnet.app_public_subnet_1.id, aws_subnet.app_public_subnet_2.id]
    security_groups  = [aws_security_group.ecs_service_sg.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api_tg.arn
    container_name   = "${local.name_prefix}-bot"
    container_port   = 3001
  }

  depends_on = [aws_lb_listener.api_http]
}

resource "aws_dynamodb_table" "guild_subscription_table" {
  name         = "${local.name_prefix}-GuildSubscriptionTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"

  attribute {
    name = "guildId"
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
    Name = "GuildSubscriptionTable"
  }
}

resource "aws_dynamodb_table" "payment_transaction_table" {
  name         = "${local.name_prefix}-PaymentTransactionTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "TransactionID"

  attribute {
    name = "TransactionID"
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
    Name = "PaymentTransactionTable"
  }
}

resource "aws_dynamodb_table" "stripe_webhook_event_table" {
  name         = "${local.name_prefix}-StripeWebhookEventTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "eventId"

  attribute {
    name = "eventId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "StripeWebhookEventTable"
  }
}

resource "aws_dynamodb_table" "interaction_receipt_table" {
  name         = "${local.name_prefix}-InteractionReceiptTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "interactionId"

  attribute {
    name = "interactionId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "InteractionReceiptTable"
  }
}

resource "aws_dynamodb_table" "active_meeting_table" {
  name         = "${local.name_prefix}-ActiveMeetingTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"

  attribute {
    name = "guildId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "ActiveMeetingTable"
  }
}

resource "aws_dynamodb_table" "access_logs_table" {
  name         = "${local.name_prefix}-AccessLogsTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "AccessLogID"

  attribute {
    name = "AccessLogID"
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
    Name = "AccessLogsTable"
  }
}

resource "aws_dynamodb_table" "recording_transcript_table" {
  name         = "${local.name_prefix}-RecordingTranscriptTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "MeetingID"

  attribute {
    name = "MeetingID"
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
    Name = "RecordingTranscriptTable"
  }
}

resource "aws_dynamodb_table" "auto_record_settings_table" {
  name         = "${local.name_prefix}-AutoRecordSettingsTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"
  range_key    = "channelId"

  attribute {
    name = "guildId"
    type = "S"
  }

  attribute {
    name = "channelId"
    type = "S"
  }

  global_secondary_index {
    name            = "GuildRecordAllIndex"
    hash_key        = "guildId"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "AutoRecordSettingsTable"
  }
}

resource "aws_dynamodb_table" "session_table" {
  name         = "${local.name_prefix}-SessionTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sid"

  attribute {
    name = "sid"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "SessionTable"
  }
}

resource "aws_dynamodb_table" "installer_table" {
  name         = "${local.name_prefix}-InstallerTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"

  attribute {
    name = "guildId"
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
    Name = "InstallerTable"
  }
}

resource "aws_dynamodb_table" "onboarding_state_table" {
  name         = "${local.name_prefix}-OnboardingStateTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"
  range_key    = "userId"

  attribute {
    name = "guildId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "OnboardingStateTable"
  }
}

# Ask Conversation Table
resource "aws_dynamodb_table" "ask_conversation_table" {
  name         = "${local.name_prefix}-AskConversationTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
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
    Name = "AskConversationTable"
  }
}

# Feedback Table
resource "aws_dynamodb_table" "feedback_table" {
  name         = "${local.name_prefix}-FeedbackTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "targetType"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "TargetTypeCreatedAtIndex"
    hash_key        = "targetType"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "FeedbackTable"
  }
}

# Contact Feedback Table
resource "aws_dynamodb_table" "contact_feedback_table" {
  name         = "${local.name_prefix}-ContactFeedbackTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "feedbackId"

  attribute {
    name = "feedbackId"
    type = "S"
  }

  attribute {
    name = "type"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = "TypeCreatedAtIndex"
    hash_key        = "type"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "ContactFeedbackTable"
  }
}

# Server Context Table
resource "aws_dynamodb_table" "server_context_table" {
  name         = "${local.name_prefix}-ServerContextTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"

  attribute {
    name = "guildId"
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
    Name = "ServerContextTable"
  }
}

# Channel Context Table
resource "aws_dynamodb_table" "channel_context_table" {
  name         = "${local.name_prefix}-ChannelContextTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"
  range_key    = "channelId"

  attribute {
    name = "guildId"
    type = "S"
  }

  attribute {
    name = "channelId"
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
    Name = "ChannelContextTable"
  }
}

# Dictionary Table
resource "aws_dynamodb_table" "dictionary_table" {
  name         = "${local.name_prefix}-DictionaryTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"
  range_key    = "termKey"

  attribute {
    name = "guildId"
    type = "S"
  }

  attribute {
    name = "termKey"
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
    Name = "DictionaryTable"
  }
}

# User Speech Settings Table
resource "aws_dynamodb_table" "user_speech_settings_table" {
  name         = "${local.name_prefix}-UserSpeechSettingsTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"
  range_key    = "userId"

  attribute {
    name = "guildId"
    type = "S"
  }

  attribute {
    name = "userId"
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
    Name = "UserSpeechSettingsTable"
  }
}

# Meeting History Table
resource "aws_dynamodb_table" "meeting_history_table" {
  name         = "${local.name_prefix}-MeetingHistoryTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "guildId"
  range_key    = "channelId_timestamp"

  attribute {
    name = "guildId"
    type = "S"
  }

  attribute {
    name = "channelId_timestamp"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  # GSI for querying all meetings in a guild by time
  global_secondary_index {
    name            = "GuildTimestampIndex"
    hash_key        = "guildId"
    range_key       = "timestamp"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_general.arn
  }

  tags = {
    Name = "MeetingHistoryTable"
  }
}

resource "aws_dynamodb_table" "meeting_share_table" {
  name         = "${local.name_prefix}-MeetingShareTable"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
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
    Name = "MeetingShareTable"
  }
}

# Output the VPC ID
output "vpc_id" {
  value = aws_vpc.app_vpc.id
}

# Output the Subnet IDs
output "public_subnet_ids" {
  value = [aws_subnet.app_public_subnet_1.id, aws_subnet.app_public_subnet_2.id]
}

# Output the Security Group ID
output "ecs_service_sg_id" {
  value = aws_security_group.ecs_service_sg.id
}

output "transcripts_bucket_name" {
  value = aws_s3_bucket.transcripts.bucket
}

output "frontend_bucket_name" {
  value = aws_s3_bucket.frontend.bucket
}

output "frontend_distribution_domain_name" {
  value = aws_cloudfront_distribution.frontend.domain_name
}

output "frontend_distribution_id" {
  value = aws_cloudfront_distribution.frontend.id
}

output "docs_bucket_name" {
  value = aws_s3_bucket.docs.bucket
}

output "docs_distribution_domain_name" {
  value = aws_cloudfront_distribution.docs.domain_name
}

output "docs_distribution_id" {
  value = aws_cloudfront_distribution.docs.id
}

# Flow logs IAM role
resource "aws_iam_role" "vpc_flow_logs_role" {
  name = "vpc_flow_logs_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect    = "Allow",
        Principal = { Service = "vpc-flow-logs.amazonaws.com" },
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "vpc_flow_logs_policy" {
  name = "vpc_flow_logs_policy"
  role = aws_iam_role.vpc_flow_logs_role.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "logs:CreateLogGroup"
        ],
        Resource = "*"
      },
      {
        Effect = "Allow",
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
          "logs:DescribeLogGroups"
        ],
        Resource = [
          aws_cloudwatch_log_group.vpc_flow_logs.arn,
          "${aws_cloudwatch_log_group.vpc_flow_logs.arn}:*"
        ]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
  name              = "/vpc/flow/app-vpc"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app_general.arn

  tags = {
    Name = "app-vpc-flow-logs"
  }
}

resource "aws_flow_log" "app_vpc_flow" {
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.vpc_flow_logs.arn
  iam_role_arn         = aws_iam_role.vpc_flow_logs_role.arn
  traffic_type         = "ALL"
  vpc_id               = aws_vpc.app_vpc.id
}

# Lock down default security group
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.app_vpc.id

  ingress = []
  egress  = []

  tags = {
    Name = "default-sg-locked"
  }
}
