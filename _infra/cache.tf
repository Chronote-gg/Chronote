variable "REDIS_URL" {
  description = "Redis URL for cache storage. Set this to an external provider (Upstash) to run without ElastiCache. Carries the password, so it belongs in TERRAFORM_TFVARS_JSON."
  type        = string
  sensitive   = true
  default     = ""
}

variable "REDIS_AUTH_TOKEN" {
  description = "Auth token for the managed Redis cluster. Unused when ENABLE_ELASTICACHE is false."
  type        = string
  sensitive   = true
  default     = ""
}

variable "ENABLE_ELASTICACHE" {
  description = "Provision an in-VPC ElastiCache cluster. False leaves the app on REDIS_URL, or on its in-process memory cache when that is empty too."
  type        = bool
  default     = true
}

locals {
  redis_auth_token         = trimspace(var.REDIS_AUTH_TOKEN)
  redis_auth_token_encoded = urlencode(local.redis_auth_token)
  redis_auth_prefix        = local.redis_auth_token_encoded != "" ? ":${local.redis_auth_token_encoded}@" : ""

  # Must be "" and never null when the cluster is absent, because redis_url
  # interpolates it. coalesce() is wrong here: it rejects empty strings as well
  # as nulls, so it cannot return "". Same length() guard as local.api_cert_arn.
  elasticache_endpoint = length(aws_elasticache_replication_group.redis) > 0 ? aws_elasticache_replication_group.redis[0].primary_endpoint_address : ""

  redis_url = (
    var.REDIS_URL != "" ? var.REDIS_URL :
    local.elasticache_endpoint != "" ? "rediss://${local.redis_auth_prefix}${local.elasticache_endpoint}:6379" :
    ""
  )
}

resource "aws_elasticache_subnet_group" "redis_subnet_group" {
  count      = var.ENABLE_ELASTICACHE ? 1 : 0
  name       = "${local.name_prefix}-redis-subnet-group"
  subnet_ids = [aws_subnet.app_public_subnet_1.id, aws_subnet.app_public_subnet_2.id]
}

resource "aws_security_group" "redis_sg" {
  #checkov:skip=CKV2_AWS_5: Attached to aws_elasticache_replication_group.redis via a count-indexed reference, which checkov's graph does not resolve.
  count       = var.ENABLE_ELASTICACHE ? 1 : 0
  description = "Redis SG for ${local.name_prefix}"
  vpc_id      = aws_vpc.app_vpc.id

  ingress {
    description     = "Allow Redis from ECS tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_service_sg.id]
  }

  egress {
    description = "Allow outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.app_vpc.cidr_block]
  }

  tags = {
    Name = "redis-sg"
  }
}

resource "aws_elasticache_replication_group" "redis" {
  #checkov:skip=CKV2_AWS_50 reason: Single-node Redis for now to keep costs low; enable Multi-AZ when required.
  count                      = var.ENABLE_ELASTICACHE ? 1 : 0
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "Redis cache for ${local.name_prefix}"
  engine                     = "redis"
  engine_version             = "7.0"
  node_type                  = "cache.t3.micro"
  num_cache_clusters         = 1
  port                       = 6379
  parameter_group_name       = "default.redis7"
  subnet_group_name          = aws_elasticache_subnet_group.redis_subnet_group[0].name
  security_group_ids         = [aws_security_group.redis_sg[0].id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = local.redis_auth_token
  automatic_failover_enabled = false
  multi_az_enabled           = false
  kms_key_id                 = aws_kms_key.app_general.arn

  # REDIS_AUTH_TOKEN gained a default so environments without a cluster can omit
  # it. This keeps it mandatory for the environments that do build one.
  lifecycle {
    precondition {
      condition     = local.redis_auth_token != ""
      error_message = "REDIS_AUTH_TOKEN is required when ENABLE_ELASTICACHE is true."
    }
  }
}
