variable "BEDROCK_DATA_AUTOMATION_PROFILE_ARN" {
  description = "Bedrock Data Automation profile ARN for eval runs"
  type        = string
  default     = ""
}

variable "BEDROCK_DATA_AUTOMATION_PROJECT_ARN" {
  description = "Bedrock Data Automation project ARN for eval runs"
  type        = string
  default     = ""
}

variable "BEDROCK_DATA_AUTOMATION_INPUT_BUCKET" {
  description = "Optional S3 bucket for Bedrock Data Automation input"
  type        = string
  default     = ""
}

variable "BEDROCK_DATA_AUTOMATION_OUTPUT_BUCKET" {
  description = "Optional S3 bucket for Bedrock Data Automation output"
  type        = string
  default     = ""
}

variable "BEDROCK_DATA_AUTOMATION_INPUT_PREFIX" {
  description = "Optional prefix for Bedrock Data Automation input objects"
  type        = string
  default     = ""
}

variable "BEDROCK_DATA_AUTOMATION_OUTPUT_PREFIX" {
  description = "Optional prefix for Bedrock Data Automation output objects"
  type        = string
  default     = ""
}

variable "BEDROCK_DATA_AUTOMATION_POLL_INTERVAL_MS" {
  description = "Optional poll interval in milliseconds for Bedrock Data Automation"
  type        = string
  default     = ""
}

variable "BEDROCK_DATA_AUTOMATION_TIMEOUT_MS" {
  description = "Optional timeout in milliseconds for Bedrock Data Automation"
  type        = string
  default     = ""
}

locals {
  bedrock_input_bucket_name  = var.BEDROCK_DATA_AUTOMATION_INPUT_BUCKET != "" ? var.BEDROCK_DATA_AUTOMATION_INPUT_BUCKET : local.transcripts_bucket_name
  bedrock_output_bucket_name = var.BEDROCK_DATA_AUTOMATION_OUTPUT_BUCKET != "" ? var.BEDROCK_DATA_AUTOMATION_OUTPUT_BUCKET : local.transcripts_bucket_name
}

resource "aws_iam_policy" "bedrock_data_automation_policy" {
  name        = "${local.name_prefix}-bedrock-data-automation"
  description = "Allow ECS tasks to invoke Bedrock Data Automation"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeDataAutomationAsync",
          "bedrock:GetDataAutomationStatus"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_bedrock_policy" {
  role       = aws_iam_role.ecs_task_app_role.name
  policy_arn = aws_iam_policy.bedrock_data_automation_policy.arn
}

resource "aws_iam_role_policy_attachment" "ecs_task_exec_bedrock_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.bedrock_data_automation_policy.arn
}

resource "aws_iam_policy" "bedrock_s3_policy" {
  name        = "${local.name_prefix}-bedrock-eval-s3"
  description = "Allow ECS tasks to read/write Bedrock eval audio artifacts"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:AbortMultipartUpload",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::${local.bedrock_input_bucket_name}",
          "arn:aws:s3:::${local.bedrock_input_bucket_name}/*",
          "arn:aws:s3:::${local.bedrock_output_bucket_name}",
          "arn:aws:s3:::${local.bedrock_output_bucket_name}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_bedrock_s3_policy" {
  role       = aws_iam_role.ecs_task_app_role.name
  policy_arn = aws_iam_policy.bedrock_s3_policy.arn
}

resource "aws_iam_role_policy_attachment" "ecs_task_exec_bedrock_s3_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = aws_iam_policy.bedrock_s3_policy.arn
}
