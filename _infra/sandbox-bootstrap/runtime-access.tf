variable "enable_sandbox_exec_channels" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_sandbox_exec_channels || (var.enable_private_evidence_store && var.environment == "sandbox" && var.aws_region == "us-east-1")
    error_message = "Runtime channels require the existing Sandbox bootstrap identity."
  }
}

# Task-side channels only. Operator ECS Exec and StartSession grants are separate.
resource "aws_iam_role_policy" "sandbox_exec_channels" {
  count = var.enable_sandbox_exec_channels ? 1 : 0
  name  = "meeting-notes-sandbox-ecs-exec-channels"
  role  = "meeting-notes-sandbox-ecs-task-app-role"
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current[0].account_id == var.sandbox_account_id
      error_message = "Runtime channel policy requires the approved Sandbox account."
    }
  }
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
      Resource = "*"
    }]
  })
}

