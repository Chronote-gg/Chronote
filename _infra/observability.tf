# -------------------------------------------
# Amazon Managed Prometheus workspace (always on)
# -----------------------------------------------

resource "aws_prometheus_workspace" "amp" {
  alias = "${local.name_prefix}-amp"
  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

output "amp_prometheus_endpoint" {
  description = "Remote write/query endpoint for the AMP workspace"
  value       = aws_prometheus_workspace.amp.prometheus_endpoint
}

output "amp_workspace_id" {
  description = "Workspace ID for AMP"
  value       = aws_prometheus_workspace.amp.id
}

# -------------------------------------------
# Amazon Managed Grafana workspace (always on; requires AWS SSO/Identity Center)
# -------------------------------------------------------------------------------

variable "grafana_suffix_seed" {
  description = "Change this value to force a new non-production AMG workspace name suffix"
  type        = string
  default     = "2025-12-18-1"
}

locals {
  effective_grafana_suffix_seed = var.environment == "prod" ? "2025-12-18-1" : var.grafana_suffix_seed
}

resource "random_id" "grafana_suffix" {
  byte_length = 2
  keepers = {
    seed = local.effective_grafana_suffix_seed
  }
}

resource "aws_grafana_workspace" "amg" {
  name                     = "${local.name_prefix}-grafana-${random_id.grafana_suffix.hex}"
  account_access_type      = "CURRENT_ACCOUNT"
  authentication_providers = ["AWS_SSO"] # Requires IAM Identity Center configured
  permission_type          = "CUSTOMER_MANAGED"
  data_sources             = ["PROMETHEUS", "CLOUDWATCH"]
  role_arn                 = aws_iam_role.grafana_workspace_role.arn
  lifecycle {
    replace_triggered_by = [random_id.grafana_suffix]
  }
  tags = {
    Project     = "${var.project_name}-discord-bot"
    Environment = var.environment
  }
}

# IAM role for AMG to access AWS data sources (CloudWatch, AMP in current account)
resource "aws_iam_role" "grafana_workspace_role" {
  name = "${local.name_prefix}-grafana-workspace-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "grafana.amazonaws.com"
        },
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "grafana_cloudwatch_access" {
  role       = aws_iam_role.grafana_workspace_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonGrafanaCloudWatchAccess"
}

resource "aws_iam_role_policy_attachment" "grafana_prometheus_access" {
  role       = aws_iam_role.grafana_workspace_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonPrometheusQueryAccess"
}

resource "aws_iam_policy" "grafana_amp_discovery" {
  name        = "${local.name_prefix}-grafana-amp-discovery"
  description = "Allow AMG to list and describe AMP workspaces for discovery"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "aps:ListWorkspaces"
        ],
        Resource = "*"
      },
      {
        Effect = "Allow",
        Action = [
          "aps:DescribeWorkspace"
        ],
        Resource = aws_prometheus_workspace.amp.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "grafana_amp_discovery_access" {
  role       = aws_iam_role.grafana_workspace_role.name
  policy_arn = aws_iam_policy.grafana_amp_discovery.arn
}

output "amg_endpoint" {
  description = "AMG workspace endpoint URL"
  value       = aws_grafana_workspace.amg.endpoint
}

output "amg_workspace_id" {
  description = "AMG workspace ID"
  value       = aws_grafana_workspace.amg.id
}
