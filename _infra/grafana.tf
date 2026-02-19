variable "grafana_api_key" {
  description = "Grafana service account token for bootstrapping. Leave empty once rotation Lambda is active."
  type        = string
  default     = ""
  sensitive   = true
}

variable "grafana_url" {
  description = "Grafana workspace endpoint, e.g., https://g-xxxx.grafana-workspace.us-east-1.amazonaws.com/"
  type        = string
  default     = "http://localhost" # placeholder; set to AMG endpoint for real use
}

variable "aws_region" {
  description = "AWS region for SigV4 when querying AMP"
  type        = string
  default     = "us-east-1"
}

variable "grafana_service_account_id" {
  description = "AMG service account numeric ID (from list-workspace-service-accounts)"
  type        = string
  default     = ""
}

variable "grafana_token_rotation_days" {
  description = "How often (in days) to rotate the Grafana token. Must be between 1 and 25 so TTL (including 5-day buffer) stays within the 30-day AMG max."
  type        = number
  default     = 25

  validation {
    condition     = var.grafana_token_rotation_days > 0 && var.grafana_token_rotation_days < 26
    error_message = "Rotation interval must be between 1 and 25 days so that rotation_days + 5 <= 30 (AMG token TTL limit)."
  }
}

# -----------------------------------------------------------------------
# Grafana provider: reads token from Secrets Manager when rotation is
# active, falls back to the manual tfvar for bootstrapping.
# -----------------------------------------------------------------------

data "aws_secretsmanager_secret_version" "grafana_token" {
  # Only read the secret version post-bootstrap (when grafana_api_key is empty).
  # During bootstrap step 3, the secret exists but has no version yet, so this
  # data source would fail. The tfvar bridges that gap.
  count     = local.grafana_rotation_enabled && var.grafana_api_key == "" ? 1 : 0
  secret_id = aws_secretsmanager_secret.grafana_api_token[0].id
}

locals {
  grafana_rotation_enabled = var.grafana_service_account_id != "" && var.grafana_url != "http://localhost"

  # Prefer the rotated secret; fall back to the manual tfvar for bootstrapping
  grafana_token_from_secret = length(data.aws_secretsmanager_secret_version.grafana_token) > 0 ? try(
    jsondecode(data.aws_secretsmanager_secret_version.grafana_token[0].secret_string)["token"], ""
  ) : ""
  grafana_resolved_token = local.grafana_token_from_secret != "" ? local.grafana_token_from_secret : var.grafana_api_key

  grafana_enabled = local.grafana_resolved_token != "" && var.grafana_url != "" && var.grafana_url != "http://localhost"
}

provider "grafana" {
  alias = "amg"
  url   = var.grafana_url
  auth  = local.grafana_resolved_token
}

# -----------------------------------------------------------------------
# Grafana resources (data source, folder, dashboard)
# -----------------------------------------------------------------------

resource "grafana_data_source" "amp" {
  count    = local.grafana_enabled ? 1 : 0
  provider = grafana.amg
  name     = "AMP Prometheus"
  type     = "prometheus"
  url      = aws_prometheus_workspace.amp.prometheus_endpoint
  json_data_encoded = jsonencode({
    httpMethod   = "GET"
    sigV4Auth    = true
    sigV4Region  = var.aws_region
    timeInterval = "15s"
  })
}

resource "grafana_folder" "observability" {
  count    = local.grafana_enabled ? 1 : 0
  provider = grafana.amg
  title    = "Meeting Notes Bot"
}

resource "grafana_dashboard" "starter" {
  count    = local.grafana_enabled ? 1 : 0
  provider = grafana.amg
  folder   = grafana_folder.observability[0].id
  config_json = templatefile("${path.module}/dashboards/starter.json", {
    datasource_uid = grafana_data_source.amp[0].uid
  })
}

# -----------------------------------------------------------------------
# Token rotation: Secrets Manager secret, Lambda, EventBridge schedule
# -----------------------------------------------------------------------

resource "aws_secretsmanager_secret" "grafana_api_token" {
  count       = local.grafana_rotation_enabled ? 1 : 0
  name        = "${local.secrets_prefix}/grafana-api-token"
  description = "Auto-rotated Grafana service account token"
  kms_key_id  = aws_kms_key.app_general.arn
  tags        = local.secrets_tags

  # Rotation is handled by our own Lambda + EventBridge schedule,
  # not the native Secrets Manager rotation integration.
  #checkov:skip=CKV2_AWS_57 reason: Rotation handled by EventBridge + Lambda, not native SM rotation.
}

# Lambda deployment package
data "archive_file" "grafana_token_rotation" {
  count       = local.grafana_rotation_enabled ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/lambda/grafana_token_rotation"
  output_path = "${path.module}/grafana_token_rotation.zip"
}

# IAM role for the rotation Lambda
resource "aws_iam_role" "grafana_token_rotation" {
  count = local.grafana_rotation_enabled ? 1 : 0
  name  = "${local.name_prefix}-grafana-token-rotation"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "grafana_token_rotation" {
  count = local.grafana_rotation_enabled ? 1 : 0
  name  = "grafana-token-rotation"
  role  = aws_iam_role.grafana_token_rotation[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "GrafanaTokenManagement"
        Effect = "Allow"
        Action = [
          "grafana:CreateWorkspaceServiceAccountToken",
          "grafana:DeleteWorkspaceServiceAccountToken",
          "grafana:ListWorkspaceServiceAccountTokens",
        ]
        Resource = aws_grafana_workspace.amg.arn
      },
      {
        Sid    = "SecretsManagerAccess"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
        ]
        Resource = aws_secretsmanager_secret.grafana_api_token[0].arn
      },
      {
        Sid    = "KMSAccess"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ]
        Resource = aws_kms_key.app_general.arn
      },
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        Sid    = "XRayTracing"
        Effect = "Allow"
        Action = [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "grafana_token_rotation" {
  count         = local.grafana_rotation_enabled ? 1 : 0
  function_name = "${local.name_prefix}-grafana-token-rotation"
  description   = "Rotates the AMG service account token and stores it in Secrets Manager"
  role          = aws_iam_role.grafana_token_rotation[0].arn
  handler       = "handler.handler"
  runtime       = "python3.13"
  timeout       = 30
  memory_size   = 128

  filename         = data.archive_file.grafana_token_rotation[0].output_path
  source_code_hash = data.archive_file.grafana_token_rotation[0].output_base64sha256

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = {
      GRAFANA_WORKSPACE_ID       = aws_grafana_workspace.amg.id
      GRAFANA_SERVICE_ACCOUNT_ID = var.grafana_service_account_id
      GRAFANA_TOKEN_SECRET_ARN   = aws_secretsmanager_secret.grafana_api_token[0].arn
      GRAFANA_TOKEN_TTL_SECONDS  = tostring(min(var.grafana_token_rotation_days + 5, 30) * 86400) # rotation interval + 5-day buffer, capped at 30 days
    }
  }

  #checkov:skip=CKV_AWS_115 reason: Reserved concurrency not needed for infrequent scheduled rotation.
  #checkov:skip=CKV_AWS_116 reason: No DLQ needed; CloudWatch alarms cover failure alerting.
  #checkov:skip=CKV_AWS_117 reason: Lambda does not need VPC access; calls only AWS APIs.
  #checkov:skip=CKV_AWS_272 reason: Code signing not required for internal infra Lambda.
  #checkov:skip=CKV_AWS_173 reason: Environment variables contain no secrets; ARNs and IDs only.

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# CloudWatch log group for the Lambda (encrypted, retained)
resource "aws_cloudwatch_log_group" "grafana_token_rotation" {
  count             = local.grafana_rotation_enabled ? 1 : 0
  name              = "/aws/lambda/${aws_lambda_function.grafana_token_rotation[0].function_name}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.app_general.arn

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# EventBridge schedule: run every N days
resource "aws_cloudwatch_event_rule" "grafana_token_rotation" {
  count               = local.grafana_rotation_enabled ? 1 : 0
  name                = "${local.name_prefix}-grafana-token-rotation"
  description         = "Rotate Grafana service account token every ${var.grafana_token_rotation_days} days"
  schedule_expression = "rate(${var.grafana_token_rotation_days} days)"

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "grafana_token_rotation" {
  count     = local.grafana_rotation_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.grafana_token_rotation[0].name
  target_id = "grafana-token-rotation"
  arn       = aws_lambda_function.grafana_token_rotation[0].arn
}

resource "aws_lambda_permission" "grafana_token_rotation_eventbridge" {
  count         = local.grafana_rotation_enabled ? 1 : 0
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.grafana_token_rotation[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.grafana_token_rotation[0].arn
}

# -----------------------------------------------------------------------
# Failure alarm: alert if the rotation Lambda errors
# -----------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "grafana_token_rotation_errors" {
  count               = local.grafana_rotation_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-grafana-token-rotation-errors"
  alarm_description   = "Grafana token rotation Lambda failed"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 86400 # 1 day
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.grafana_token_rotation[0].function_name
  }

  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}
