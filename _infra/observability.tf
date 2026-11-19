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
